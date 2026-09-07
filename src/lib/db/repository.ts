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
  type Analysis,
  type AnalysisInput,
  type AuctionItem,
  type AuctionItemInput,
  type IsoDateTime,
  type ItemQuery,
  type SortDirection,
  type SortKey,
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

function toAuctionItem(row: ItemRow): AuctionItem {
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

const ANALYZED_EXISTS = "EXISTS (SELECT 1 FROM analyses WHERE analyses.item_id = items.id)";

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
}

export function createRepository(db: Db): AuctionRepository {
  const selectItemIdByKey = db.prepare<
    { court: string; caseNo: string; itemNo: string },
    { id: number }
  >(`SELECT id FROM items WHERE court = @court AND case_no = @caseNo AND item_no = @itemNo`);

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

  const selectUsageTypes = db.prepare<[], { usage_type: string }>(`
    SELECT DISTINCT usage_type FROM items
    WHERE usage_type IS NOT NULL
    ORDER BY usage_type
  `);

  const upsertBatch = db.transaction(
    (items: AuctionItemInput[], now: string): UpsertItemsResult => {
      let inserted = 0;
      let updated = 0;
      for (const item of items) {
        // 먼저 존재 여부를 본다. ON CONFLICT는 신규/갱신 모두 changes=1이라
        // 그것만으로는 구분할 수 없고, 같은 배치 안의 중복 키도 정확히 세야 한다.
        const existing = selectItemIdByKey.get({
          court: item.court,
          caseNo: item.caseNo,
          itemNo: item.itemNo,
        });
        upsertItem.run({
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
        if (existing) updated += 1;
        else inserted += 1;
      }
      return { inserted, updated };
    },
  );

  return {
    upsertItems(items, options) {
      if (items.length === 0) return { inserted: 0, updated: 0 };
      return upsertBatch(items, options?.now ?? new Date().toISOString());
    },

    listItems(query = {}) {
      const page = normalizePage(query.page);
      const pageSize = normalizePageSize(query.pageSize);
      const filter = buildFilter(query);
      const orderBy = orderByClause(query.sort, query.direction);

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
      const rows = db
        .prepare<BindParams, ItemRow>(
          `SELECT * FROM items ${filter.where} ${orderBy} LIMIT @limit OFFSET @offset`,
        )
        .all({
          ...filter.params,
          limit: pageSize,
          offset: (page - 1) * pageSize,
        });

      return { items: rows.map(toAuctionItem), total, page, pageSize };
    },

    getItemById(id) {
      const row = selectItemById.get({ id });
      return row ? toAuctionItem(row) : null;
    },

    listUsageTypes() {
      return selectUsageTypes.all().map((row) => row.usage_type);
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
