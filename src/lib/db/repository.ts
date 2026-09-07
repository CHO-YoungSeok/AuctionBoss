/**
 * items / analyses 저장소.
 *
 * snake_case ↔ camelCase 변환은 전부 이 파일 안에서 끝난다. 이 모듈 밖으로 나가는 값은
 * 항상 `src/lib/domain`의 도메인 타입이다.
 *
 * `createRepository(db)`로 연결을 명시해 만들 수 있고, 모듈 최상단 export 함수들은
 * 기본 싱글턴 연결(`getDb()`)을 쓴다. 테스트는 전자를 써서 env·실제 data/ 디렉터리에
 * 의존하지 않는다.
 */
import {
  DEFAULT_PAGE_SIZE,
  DEFAULT_SORT_DIRECTION,
  DEFAULT_SORT_KEY,
  MAX_PAGE_SIZE,
  WATCHED_FIELDS,
  type Analysis,
  type AnalysisInput,
  type AuctionItem,
  type AuctionItemInput,
  type IsoDateTime,
  type ItemChange,
  type ItemQuery,
  type SortDirection,
  type SortKey,
  type WatchedField,
} from "@/lib/domain";

import { getDb, type Db } from "./client";
import { ItemNotFoundError } from "./errors";

// 페이지 크기 상수의 정의는 도메인(`item-query.ts`)에 있다 — 파서와 저장소가 같은 값을
// 써야 하고, 도메인이 db를 import하는 역방향 의존을 만들지 않기 위함.
// 기존 `@/lib/db`에서 import하던 곳(API 라우트 등)이 그대로 동작하도록 여기서 다시 내보낸다.
export { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE };

export interface UpsertItemsResult {
  inserted: number;
  updated: number;
  /**
   * 감시 대상 필드가 실제로 바뀐 **물건 수**(변경 이력 행 수가 아니다). 기준점 행은
   * 세지 않는다 — 신규는 이미 `inserted`가 센다 (design.md D3).
   */
  changed: number;
}

/**
 * `listItems`의 인자. 도메인의 `ItemQuery`와 같은 타입이다.
 * 이 이름으로 import하던 기존 코드를 위해 별칭을 남겨 둔다.
 */
export type ListItemsOptions = ItemQuery;

export interface ListItemsResult {
  items: AuctionItem[];
  total: number;
  page: number;
  pageSize: number;
}

interface ItemRow {
  id: number;
  court: string;
  case_no: string;
  item_no: string;
  address: string | null;
  usage_type: string | null;
  appraisal_price: number | null;
  min_bid_price: number | null;
  auction_date: string | null;
  failed_bid_count: number | null;
  status: string | null;
  first_seen_at: string;
  last_seen_at: string;
}

interface AnalysisRow {
  id: number;
  item_id: number;
  body: string;
  model: string | null;
  prompt_version: string;
  analyzed_at: string;
}

interface ItemChangeRow {
  id: number;
  item_id: number;
  field: string;
  old_value: string | null;
  new_value: string | null;
  changed_at: string;
}

/** `listItems`의 서브쿼리 컬럼까지 포함한 행. 기본 `ItemRow`를 확장한다(design.md D6). */
interface ItemListRow extends ItemRow {
  last_changed_at: string | null;
}

/**
 * `lastChangedAt`은 `listItems`의 스칼라 서브쿼리로만 채워진다(design.md D6). 다른 조회
 * 경로(`getItemById` 등)는 이 값을 계산하지 않으므로 인자를 생략하면 null이 된다.
 */
function toAuctionItem(row: ItemRow, lastChangedAt: string | null = null): AuctionItem {
  return {
    id: row.id,
    court: row.court,
    caseNo: row.case_no,
    itemNo: row.item_no,
    address: row.address,
    usageType: row.usage_type,
    appraisalPrice: row.appraisal_price,
    minBidPrice: row.min_bid_price,
    auctionDate: row.auction_date,
    failedBidCount: row.failed_bid_count,
    status: row.status,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    lastChangedAt,
  };
}

function toAnalysis(row: AnalysisRow): Analysis {
  return {
    id: row.id,
    itemId: row.item_id,
    body: row.body,
    model: row.model,
    promptVersion: row.prompt_version,
    analyzedAt: row.analyzed_at,
  };
}

function toItemChange(row: ItemChangeRow): ItemChange {
  return {
    id: row.id,
    itemId: row.item_id,
    field: row.field as WatchedField,
    oldValue: row.old_value,
    newValue: row.new_value,
    changedAt: row.changed_at,
  };
}

/** 감시 필드 하나의 비교 방식. 가격·유찰횟수는 숫자로, 매각기일·상태는 문자열로 (design.md D3). */
type FieldComparisonKind = "numeric" | "string";

interface WatchedFieldDef {
  field: WatchedField;
  kind: FieldComparisonKind;
  /** 기존 행(snake_case)에서 이 필드의 저장 전 값을 읽는 컬럼 키. */
  column: "min_bid_price" | "failed_bid_count" | "auction_date" | "status";
}

const WATCHED_FIELD_DEFS: readonly WatchedFieldDef[] = [
  { field: "minBidPrice", kind: "numeric", column: "min_bid_price" },
  { field: "failedBidCount", kind: "numeric", column: "failed_bid_count" },
  { field: "auctionDate", kind: "string", column: "auction_date" },
  { field: "status", kind: "string", column: "status" },
];

// WATCHED_FIELDS(도메인 상수)와 WATCHED_FIELD_DEFS(저장소 내부 비교 규칙)가 같은 필드
// 집합을 가리키는지 모듈 로드 시점에 확인한다 — 둘 중 하나만 고치는 실수를 조용히
// 넘어가지 않기 위함.
if (
  WATCHED_FIELD_DEFS.length !== WATCHED_FIELDS.length ||
  WATCHED_FIELD_DEFS.some((def, index) => def.field !== WATCHED_FIELDS[index])
) {
  throw new Error("WATCHED_FIELD_DEFS가 WATCHED_FIELDS와 어긋났습니다");
}

type FieldValue = string | number | null;

/** null↔null은 같음, null↔값은 변경. 숫자 필드는 숫자로, 그 외는 문자열로 비교한다. */
function watchedValuesEqual(a: FieldValue, b: FieldValue, kind: FieldComparisonKind): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  return kind === "numeric" ? Number(a) === Number(b) : String(a) === String(b);
}

/** 이력 테이블(TEXT 컬럼)에 저장할 형태로 바꾼다. null은 null 그대로. */
function toHistoryValue(value: FieldValue): string | null {
  return value === null ? null : String(value);
}

interface DetectedChange {
  field: WatchedField;
  oldValue: string | null;
  newValue: string | null;
}

/** 기존 행과 새 값 사이에 실제로 다른 감시 필드만 골라낸다. */
function detectWatchedChanges(
  existing: Pick<ItemRow, "min_bid_price" | "failed_bid_count" | "auction_date" | "status">,
  incoming: AuctionItemInput,
): DetectedChange[] {
  const changes: DetectedChange[] = [];
  for (const def of WATCHED_FIELD_DEFS) {
    const oldRaw: FieldValue = existing[def.column];
    const newRaw: FieldValue = incoming[def.field];
    if (!watchedValuesEqual(oldRaw, newRaw, def.kind)) {
      changes.push({ field: def.field, oldValue: toHistoryValue(oldRaw), newValue: toHistoryValue(newRaw) });
    }
  }
  return changes;
}

/**
 * 최초 저장 시의 기준점 행(design.md D2). `old_value = NULL`로 고정되고, 값이 NULL인
 * 필드는 기준점 자체를 만들지 않는다(양쪽 다 NULL인 무의미한 행을 막기 위함).
 */
function baselineWatchedChanges(incoming: AuctionItemInput): DetectedChange[] {
  const changes: DetectedChange[] = [];
  for (const def of WATCHED_FIELD_DEFS) {
    const value: FieldValue = incoming[def.field];
    if (value === null) continue;
    changes.push({ field: def.field, oldValue: null, newValue: toHistoryValue(value) });
  }
  return changes;
}

const ANALYZED_EXISTS = "EXISTS (SELECT 1 FROM analyses WHERE analyses.item_id = items.id)";

/**
 * 재분석 대상 판정 SQL (design.md D4). 세 조건의 OR:
 * 1) 분석 행이 아예 없음
 * 2) 최신 분석 이후에 **실제** 변경(`old_value IS NOT NULL` — 기준점 제외)이 있음
 * 3) 최신 분석의 `prompt_version`이 요청된 `@promptVersion`과 다름(같음/다름만 본다 —
 *    세만틱 버전 비교를 하지 않는 이유는 design.md D4에 기록돼 있다)
 *
 * "최신 분석"의 기준(`analyzed_at DESC, id DESC`)은 `getLatestAnalysis`와 같다.
 * 조건 2는 `>` (초과)를 쓴다 — 최신 분석과 같은 시각이거나 그 이전 변경은 이미 그
 * 분석에 반영됐다고 본다(경계 포함이면 분석 직후의 자기 자신 이력까지 재분석 대상으로
 * 오판할 수 있다).
 *
 * `@promptVersion` 바인딩이 필요하다 — 없으면 `buildFilter`가 미리 막는다.
 */
const NEEDS_ANALYSIS_PREDICATE = `(
  NOT EXISTS (SELECT 1 FROM analyses na WHERE na.item_id = items.id)
  OR EXISTS (
    SELECT 1 FROM item_changes nc
    WHERE nc.item_id = items.id
      AND nc.old_value IS NOT NULL
      AND nc.changed_at > (
        SELECT nla.analyzed_at FROM analyses nla
        WHERE nla.item_id = items.id
        ORDER BY nla.analyzed_at DESC, nla.id DESC
        LIMIT 1
      )
  )
  OR (
    SELECT nlv.prompt_version FROM analyses nlv
    WHERE nlv.item_id = items.id
    ORDER BY nlv.analyzed_at DESC, nlv.id DESC
    LIMIT 1
  ) != @promptVersion
)`;

/**
 * 재분석 후보 정렬: 가장 오래 전에 분석된 것 우선(`analyzed_at ASC`, design.md D5) —
 * 최신 변경 우선으로 하면 자주 바뀌는 물건이 재분석 한도를 독점한다.
 *
 * 분석이 아예 없는 물건(조건 1)은 서브쿼리가 NULL을 내고, SQLite는 ASC에서 NULL을
 * 맨 앞에 둔다 — 하지만 이 값은 `listItems`가 `analyzed=false`로 이미 신규 한도만큼
 * 가져간 물건과 겹칠 수 있어 워커가 두 결과를 합칠 때 중복을 제거한다(workers/analyzer.ts,
 * design.md D4의 "신규 제외"). 이 순서 자체가 그 dedupe를 보장하지는 않는다.
 */
const NEEDS_ANALYSIS_ORDER = `ORDER BY (
  SELECT ord.analyzed_at FROM analyses ord
  WHERE ord.item_id = items.id
  ORDER BY ord.analyzed_at DESC, ord.id DESC
  LIMIT 1
) ASC, items.id ASC`;

/**
 * 정렬 기준 → SQL 표현식 화이트리스트 (design.md D2).
 *
 * 사용자 입력이 SQL에 직접 들어가는 경로를 만들지 않는다. `SortKey`에 없는 값은
 * `orderByClause`가 던진다 — 조용히 기본값으로 바꾸면 잘못된 정렬을 눈치채지 못한다.
 */
const SORT_EXPRESSIONS: Record<SortKey, string> = {
  auctionDate: "items.auction_date",
  minBidPrice: "items.min_bid_price",
  // 감정가 대비 최저가 비율. 감정가가 0이면 0 나눗셈이 되므로 NULLIF로 NULL을 만들고
  // 아래 NULL 규칙(항상 뒤로)에 맡긴다.
  bidRatio: "CAST(items.min_bid_price AS REAL) / NULLIF(items.appraisal_price, 0)",
  failedBidCount: "items.failed_bid_count",
};

function orderByClause(sort: SortKey | undefined, direction: SortDirection | undefined): string {
  // 생략 시 기존 동작(매각기일 오름차순)과 같은 SQL이 나오도록 기본값을 쓴다.
  // 기본값 자체는 도메인(`DEFAULT_SORT_KEY`/`DEFAULT_SORT_DIRECTION`)에 있다 — 여기·페이지·
  // 폼이 각자 하드코딩하면 하나만 바꿔도 나머지와 어긋난다.
  const key = sort ?? DEFAULT_SORT_KEY;
  // `hasOwnProperty`로 확인하는 이유: 타입 밖(JS 호출자)에서 `"constructor"` 같은 값이 오면
  // 단순 인덱싱은 프로토타입의 함수를 돌려주고 그게 SQL 문자열에 끼어들 수 있다.
  const expr = Object.prototype.hasOwnProperty.call(SORT_EXPRESSIONS, key)
    ? SORT_EXPRESSIONS[key]
    : undefined;
  if (typeof expr !== "string") throw new Error(`지원하지 않는 sort 값: ${String(sort)}`);

  const dir = direction ?? DEFAULT_SORT_DIRECTION;
  if (dir !== "asc" && dir !== "desc") {
    throw new Error(`지원하지 않는 direction 값: ${String(direction)}`);
  }

  // `<expr> IS NULL`을 항상 오름차순 선행 키로 둬서 NULL을 방향과 무관하게 뒤로 보낸다.
  // 마지막 `items.id`는 동률 행이 페이지 경계에서 중복·누락되지 않게 하는 안정 정렬 키다.
  return `ORDER BY (${expr}) IS NULL, (${expr}) ${dir === "desc" ? "DESC" : "ASC"}, items.id ASC`;
}

/** LIKE 이스케이프 문자. 사용자 입력 안의 이 문자 자신도 이스케이프해야 한다. */
const LIKE_ESCAPE_CHAR = "\\";

/**
 * LIKE 패턴에 넣을 사용자 입력을 이스케이프한다.
 * `%`/`_`를 그대로 두면 `%`만 입력해도 전체가 매칭된다 (design.md D1).
 */
export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `${LIKE_ESCAPE_CHAR}${char}`);
}

/** `listItems`가 쓰는 바인딩 파라미터. 값은 전부 여기 담기고 SQL에는 이름만 들어간다. */
type BindParams = Record<string, string | number>;

interface Filter {
  /** `""` 또는 `"WHERE ..."`. */
  where: string;
  params: BindParams;
}

/**
 * 조건이 있는 필터만 모아 `AND`로 연결한다. 값은 예외 없이 바인딩 파라미터다 —
 * 문자열 보간은 하지 않는다 (design.md D1).
 *
 * 주의: `min_bid_price`/`failed_bid_count`가 NULL인 행은 비교식이 참이 되지 않으므로
 * 가격·유찰횟수 필터를 걸면 제외된다. "값을 모르는 물건"을 조건에 맞다고 보는 것보다
 * 제외하는 편이 사용자 기대에 가깝다.
 */
function buildFilter(query: ItemQuery): Filter {
  const conditions: string[] = [];
  const params: BindParams = {};

  if (query.analyzed === true) {
    conditions.push(ANALYZED_EXISTS);
  } else if (query.analyzed === false) {
    conditions.push(`NOT ${ANALYZED_EXISTS}`);
  } else if (query.analyzed !== undefined) {
    throw new Error(`지원하지 않는 analyzed 값: ${String(query.analyzed)}`);
  }

  if (query.needsAnalysis === true) {
    // API 계층(item-query.ts의 strict 파서)이 이미 이 조합을 막지만, 저장소를 직접
    // 호출하는 경로(테스트 포함)도 조용히 잘못된 결과를 내지 않고 던지게 한다.
    if (query.promptVersion === undefined) {
      throw new Error("needsAnalysis=true이면 promptVersion이 필요합니다");
    }
    conditions.push(NEEDS_ANALYSIS_PREDICATE);
    params.promptVersion = query.promptVersion;
  } else if (query.needsAnalysis !== undefined) {
    throw new Error(`지원하지 않는 needsAnalysis 값: ${String(query.needsAnalysis)}`);
  }

  const usageTypes = query.usageTypes?.filter((usageType) => usageType !== "");
  if (usageTypes !== undefined && usageTypes.length > 0) {
    const placeholders = usageTypes.map((usageType, index) => {
      params[`usage${index}`] = usageType;
      return `@usage${index}`;
    });
    conditions.push(`items.usage_type IN (${placeholders.join(", ")})`);
  }

  if (query.minPrice !== undefined) {
    conditions.push("items.min_bid_price >= @minPrice");
    params.minPrice = query.minPrice;
  }

  if (query.maxPrice !== undefined) {
    conditions.push("items.min_bid_price <= @maxPrice");
    params.maxPrice = query.maxPrice;
  }

  if (query.minFailedBidCount !== undefined) {
    conditions.push("items.failed_bid_count >= @minFailedBidCount");
    params.minFailedBidCount = query.minFailedBidCount;
  }

  const keyword = query.addressKeyword?.trim();
  if (keyword !== undefined && keyword !== "") {
    conditions.push("items.address LIKE @addressKeyword ESCAPE @likeEscape");
    params.addressKeyword = `%${escapeLikePattern(keyword)}%`;
    params.likeEscape = LIKE_ESCAPE_CHAR;
  }

  return {
    where: conditions.length === 0 ? "" : `WHERE ${conditions.join(" AND ")}`,
    params,
  };
}

function normalizePage(page: number | undefined): number {
  if (page === undefined || !Number.isFinite(page)) return 1;
  return Math.max(1, Math.trunc(page));
}

function normalizePageSize(pageSize: number | undefined): number {
  if (pageSize === undefined || !Number.isFinite(pageSize)) return DEFAULT_PAGE_SIZE;
  return Math.min(MAX_PAGE_SIZE, Math.max(1, Math.trunc(pageSize)));
}

export interface AuctionRepository {
  upsertItems(items: AuctionItemInput[], options?: { now?: IsoDateTime }): UpsertItemsResult;
  listItems(query?: ItemQuery): ListItemsResult;
  getItemById(id: number): AuctionItem | null;
  /** 저장된 물건에 실제로 존재하는 용도 목록. 중복 없이 정렬해서 돌려준다. */
  listUsageTypes(): string[];
  insertAnalysis(input: AnalysisInput, options?: { now?: IsoDateTime }): Analysis;
  getLatestAnalysis(itemId: number): Analysis | null;
  /** 물건의 모든 분석을 최신순으로 돌려준다(재분석 이력 열람용, task 6.3). 없으면 빈 배열. */
  listAnalyses(itemId: number): Analysis[];
  /** 물건의 변경 이력을 시간순으로 돌려준다. 이력이 없으면 빈 배열이다(오류가 아니다). */
  listItemChanges(itemId: number): ItemChange[];
}

interface ExistingItemRow {
  id: number;
  min_bid_price: number | null;
  failed_bid_count: number | null;
  auction_date: string | null;
  status: string | null;
}

export function createRepository(db: Db): AuctionRepository {
  // 감시 필드까지 함께 읽어 변경 감지에 쓴다(design.md D3) — 별도 SELECT를 추가하지 않고
  // 기존에 있던 사전 조회 하나를 확장한다.
  const selectItemIdByKey = db.prepare<
    { court: string; caseNo: string; itemNo: string },
    ExistingItemRow
  >(`
    SELECT id, min_bid_price, failed_bid_count, auction_date, status
    FROM items WHERE court = @court AND case_no = @caseNo AND item_no = @itemNo
  `);

  // 자연 키 충돌 시 갱신 대상은 "소스에서 다시 온 값"과 last_seen_at 뿐이다.
  // first_seen_at은 SET 목록에 없으므로 어떤 경우에도 덮어써지지 않는다.
  const upsertItem = db.prepare(`
    INSERT INTO items (
      court, case_no, item_no, address, usage_type, appraisal_price,
      min_bid_price, auction_date, failed_bid_count, status,
      first_seen_at, last_seen_at
    ) VALUES (
      @court, @caseNo, @itemNo, @address, @usageType, @appraisalPrice,
      @minBidPrice, @auctionDate, @failedBidCount, @status,
      @now, @now
    )
    ON CONFLICT (court, case_no, item_no) DO UPDATE SET
      address          = excluded.address,
      usage_type       = excluded.usage_type,
      appraisal_price  = excluded.appraisal_price,
      min_bid_price    = excluded.min_bid_price,
      auction_date     = excluded.auction_date,
      failed_bid_count = excluded.failed_bid_count,
      status           = excluded.status,
      last_seen_at     = excluded.last_seen_at
  `);

  const selectItemById = db.prepare<{ id: number }, ItemRow>(
    `SELECT * FROM items WHERE id = @id`,
  );

  const insertItemChange = db.prepare(`
    INSERT INTO item_changes (item_id, field, old_value, new_value, changed_at)
    VALUES (@itemId, @field, @oldValue, @newValue, @changedAt)
  `);

  const selectItemChanges = db.prepare<{ itemId: number }, ItemChangeRow>(`
    SELECT * FROM item_changes WHERE item_id = @itemId ORDER BY changed_at ASC, id ASC
  `);

  const insertAnalysisStmt = db.prepare(`
    INSERT INTO analyses (item_id, body, model, prompt_version, analyzed_at)
    VALUES (@itemId, @body, @model, @promptVersion, @analyzedAt)
  `);

  const selectAnalysisById = db.prepare<{ id: number }, AnalysisRow>(
    `SELECT * FROM analyses WHERE id = @id`,
  );

  const selectLatestAnalysis = db.prepare<{ itemId: number }, AnalysisRow>(`
    SELECT * FROM analyses
    WHERE item_id = @itemId
    ORDER BY analyzed_at DESC, id DESC
    LIMIT 1
  `);

  const selectAnalyses = db.prepare<{ itemId: number }, AnalysisRow>(`
    SELECT * FROM analyses
    WHERE item_id = @itemId
    ORDER BY analyzed_at DESC, id DESC
  `);

  const selectUsageTypes = db.prepare<[], { usage_type: string }>(`
    SELECT DISTINCT usage_type FROM items
    WHERE usage_type IS NOT NULL
    ORDER BY usage_type
  `);

  const upsertBatch = db.transaction(
    (items: AuctionItemInput[], now: string): UpsertItemsResult => {
      let inserted = 0;
      let updated = 0;
      let changed = 0;
      for (const item of items) {
        // 먼저 존재 여부와 감시 필드의 저장 전 값을 본다. ON CONFLICT는 신규/갱신 모두
        // changes=1이라 그것만으로는 구분할 수 없고, 같은 배치 안의 중복 키도 정확히
        // 세야 한다. 감시 필드 비교는 upsertItem이 덮어쓰기 **전**에만 가능하다
        // (design.md D3) — 그래서 별도 쿼리로 빼지 않고 이 사전 SELECT를 확장했다.
        const existing = selectItemIdByKey.get({
          court: item.court,
          caseNo: item.caseNo,
          itemNo: item.itemNo,
        });
        const info = upsertItem.run({
          court: item.court,
          caseNo: item.caseNo,
          itemNo: item.itemNo,
          address: item.address,
          usageType: item.usageType,
          appraisalPrice: item.appraisalPrice,
          minBidPrice: item.minBidPrice,
          auctionDate: item.auctionDate,
          failedBidCount: item.failedBidCount,
          status: item.status,
          now,
        });

        if (existing) {
          updated += 1;
          const diffs = detectWatchedChanges(existing, item);
          if (diffs.length > 0) changed += 1;
          for (const diff of diffs) {
            insertItemChange.run({
              itemId: existing.id,
              field: diff.field,
              oldValue: diff.oldValue,
              newValue: diff.newValue,
              changedAt: now,
            });
          }
        } else {
          inserted += 1;
          const itemId = Number(info.lastInsertRowid);
          for (const baseline of baselineWatchedChanges(item)) {
            insertItemChange.run({
              itemId,
              field: baseline.field,
              oldValue: baseline.oldValue,
              newValue: baseline.newValue,
              changedAt: now,
            });
          }
        }
      }
      return { inserted, updated, changed };
    },
  );

  return {
    upsertItems(items, options) {
      if (items.length === 0) return { inserted: 0, updated: 0, changed: 0 };
      return upsertBatch(items, options?.now ?? new Date().toISOString());
    },

    listItems(query = {}) {
      const page = normalizePage(query.page);
      const pageSize = normalizePageSize(query.pageSize);
      const filter = buildFilter(query);
      // 재분석 후보 조회는 정렬 기준이 고정이다(design.md D5, 가장 오래 분석된 것
      // 우선) — 호출자가 준 sort/direction은 이 모드에서는 쓰이지 않는다.
      const orderBy =
        query.needsAnalysis === true
          ? NEEDS_ANALYSIS_ORDER
          : orderByClause(query.sort, query.direction);

      // 필터 조합마다 SQL이 달라져 문장을 미리 준비해 둘 수 없다 — 그때그때 `db.prepare`한다.
      // 현재 규모(수백 건, 페이지당 요청)에서 `db.prepare` 자체의 비용은 무시할 만큼 작다
      // (design.md 비목표: 이 규모에서 캐시가 아끼는 시간보다 캐시 자체의 코드·상태가
      // 더 비싸다). 필터·정렬 조합이 늘어 이게 실제로 측정 가능한 병목이 되면 그때
      // 다시 캐시를 검토한다.
      // 전체 건수는 목록과 **같은 WHERE**로 센다 — 필터 적용 후 건수여야 페이지네이션이 맞는다.
      const total =
        db
          .prepare<BindParams, { total: number }>(`SELECT COUNT(*) AS total FROM items ${filter.where}`)
          .get(filter.params)?.total ?? 0;
      // "최근 변경 시각"은 스칼라 서브쿼리 컬럼으로만 추가한다(design.md D6) — WHERE/ORDER
      // BY/total(위)에는 관여하지 않아 기존 필터·정렬 로직을 건드리지 않는다. 기준점 행
      // (old_value IS NULL)은 실제 변경이 아니므로 여기서 제외한다.
      const rows = db
        .prepare<BindParams, ItemListRow>(
          `SELECT items.*, (
             SELECT MAX(item_changes.changed_at)
             FROM item_changes
             WHERE item_changes.item_id = items.id AND item_changes.old_value IS NOT NULL
           ) AS last_changed_at
           FROM items ${filter.where} ${orderBy} LIMIT @limit OFFSET @offset`,
        )
        .all({
          ...filter.params,
          limit: pageSize,
          offset: (page - 1) * pageSize,
        });

      return {
        items: rows.map((row) => toAuctionItem(row, row.last_changed_at)),
        total,
        page,
        pageSize,
      };
    },

    getItemById(id) {
      const row = selectItemById.get({ id });
      return row ? toAuctionItem(row) : null;
    },

    listUsageTypes() {
      return selectUsageTypes.all().map((row) => row.usage_type);
    },

    listItemChanges(itemId) {
      return selectItemChanges.all({ itemId }).map(toItemChange);
    },

    insertAnalysis(input, options) {
      const analyzedAt = options?.now ?? new Date().toISOString();
      // FK 위반 오류는 원인을 구분하기 어려우므로 먼저 명시적으로 확인해
      // API 계층이 404로 옮길 수 있는 오류를 던진다.
      if (!selectItemById.get({ id: input.itemId })) {
        throw new ItemNotFoundError(input.itemId);
      }
      const info = insertAnalysisStmt.run({
        itemId: input.itemId,
        body: input.body,
        model: input.model,
        promptVersion: input.promptVersion,
        analyzedAt,
      });
      const row = selectAnalysisById.get({ id: Number(info.lastInsertRowid) });
      if (!row) throw new Error("분석 결과 저장 직후 조회에 실패했습니다");
      return toAnalysis(row);
    },

    getLatestAnalysis(itemId) {
      const row = selectLatestAnalysis.get({ itemId });
      return row ? toAnalysis(row) : null;
    },

    listAnalyses(itemId) {
      return selectAnalyses.all({ itemId }).map(toAnalysis);
    },
  };
}

let defaultRepository: AuctionRepository | undefined;
let defaultRepositoryDb: Db | undefined;

/** 기본 싱글턴 연결에 붙은 저장소. */
export function getRepository(): AuctionRepository {
  const db = getDb();
  if (!defaultRepository || defaultRepositoryDb !== db) {
    defaultRepository = createRepository(db);
    defaultRepositoryDb = db;
  }
  return defaultRepository;
}

export function upsertItems(
  items: AuctionItemInput[],
  options?: { now?: IsoDateTime },
): UpsertItemsResult {
  return getRepository().upsertItems(items, options);
}

export function listItems(query?: ItemQuery): ListItemsResult {
  return getRepository().listItems(query);
}

export function getItemById(id: number): AuctionItem | null {
  return getRepository().getItemById(id);
}

export function listUsageTypes(): string[] {
  return getRepository().listUsageTypes();
}

export function insertAnalysis(
  input: AnalysisInput,
  options?: { now?: IsoDateTime },
): Analysis {
  return getRepository().insertAnalysis(input, options);
}

export function getLatestAnalysis(itemId: number): Analysis | null {
  return getRepository().getLatestAnalysis(itemId);
}

export function listAnalyses(itemId: number): Analysis[] {
  return getRepository().listAnalyses(itemId);
}

export function listItemChanges(itemId: number): ItemChange[] {
  return getRepository().listItemChanges(itemId);
}
