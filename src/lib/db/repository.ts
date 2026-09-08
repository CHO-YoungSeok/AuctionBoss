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
  type ItemChangeKind,
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
  // ↓ 확장 컬럼 (enrich-item-fields, design.md D1). snake_case는 이 파일 밖으로 새지
  // 않는다 — toAuctionItem이 camelCase 도메인 타입으로 변환한다.
  min_area: number | null;
  max_area: number | null;
  building_description: string | null;
  min_bid_price_round1: number | null;
  min_bid_price_round2: number | null;
  min_bid_price_round3: number | null;
  min_bid_price_round4: number | null;
  min_bid_price_rate_round1: number | null;
  min_bid_price_rate_round2: number | null;
  usage_code_large: string | null;
  usage_code_medium: string | null;
  usage_code_small: string | null;
  sido: string | null;
  sigungu: string | null;
  dong: string | null;
  lot_number: string | null;
  building_name: string | null;
  building_unit: string | null;
  coordinate_x: string | null;
  coordinate_y: string | null;
  coordinate_level: string | null;
  auction_time: string | null;
  auction_place: string | null;
  auction_decision_date: string | null;
  auction_round: number | null;
  note: string | null;
  duplicate_case_no: string | null;
  merged_case_no: string | null;
  court_department: string | null;
  court_phone: string | null;
  status_code: string | null;
  item_status_code: string | null;
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
  kind: ItemChangeKind;
}

/** `listItems`의 서브쿼리 컬럼까지 포함한 행. 기본 `ItemRow`를 확장한다(design.md D6).
 * `bookmarked`는 add-bookmarks-and-feed가 같은 방식(스칼라 서브쿼리)으로 추가했다. */
interface ItemListRow extends ItemRow {
  last_changed_at: string | null;
  /** SQLite의 `EXISTS(...)`는 0/1 정수로 나온다. */
  bookmarked: number;
}

/**
 * `lastChangedAt`은 스칼라 서브쿼리로 채워진다(design.md D6). `listItems`와
 * `getItemById` 둘 다 이 값을 계산해서 넘긴다(코드 리뷰 finding 5 — 이전에는
 * `getItemById`만 이 인자를 생략해 항상 null을 돌려줬다, `GET /api/items/[id]`가 그 값을
 * 그대로 노출해 단일 물건 조회에서만 `lastChangedAt`이 항상 null로 보이는 버그였다).
 * 인자를 생략하는 호출은 여전히 null이 기본값이다(이 값을 모르는 다른 생성 경로 대비).
 */
function toAuctionItem(
  row: ItemRow,
  lastChangedAt: string | null = null,
  bookmarked: number | boolean = false,
): AuctionItem {
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
    bookmarked: Boolean(bookmarked),
    minArea: row.min_area,
    maxArea: row.max_area,
    buildingDescription: row.building_description,
    minBidPriceRound1: row.min_bid_price_round1,
    minBidPriceRound2: row.min_bid_price_round2,
    minBidPriceRound3: row.min_bid_price_round3,
    minBidPriceRound4: row.min_bid_price_round4,
    minBidPriceRateRound1: row.min_bid_price_rate_round1,
    minBidPriceRateRound2: row.min_bid_price_rate_round2,
    usageCodeLarge: row.usage_code_large,
    usageCodeMedium: row.usage_code_medium,
    usageCodeSmall: row.usage_code_small,
    sido: row.sido,
    sigungu: row.sigungu,
    dong: row.dong,
    lotNumber: row.lot_number,
    buildingName: row.building_name,
    buildingUnit: row.building_unit,
    coordinateX: row.coordinate_x,
    coordinateY: row.coordinate_y,
    coordinateLevel: row.coordinate_level,
    auctionTime: row.auction_time,
    auctionPlace: row.auction_place,
    auctionDecisionDate: row.auction_decision_date,
    auctionRound: row.auction_round,
    note: row.note,
    duplicateCaseNo: row.duplicate_case_no,
    mergedCaseNo: row.merged_case_no,
    courtDepartment: row.court_department,
    courtPhone: row.court_phone,
    statusCode: row.status_code,
    itemStatusCode: row.item_status_code,
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
    kind: row.kind,
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
  /** 항상 `"change"`다 — 기준점은 `baselineWatchedChanges`가 별도로 만든다(finding 1). */
  kind: "change";
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
      changes.push({
        field: def.field,
        oldValue: toHistoryValue(oldRaw),
        newValue: toHistoryValue(newRaw),
        kind: "change",
      });
    }
  }
  return changes;
}

interface BaselineChange {
  field: WatchedField;
  newValue: string;
  /** 항상 `"baseline"`이다 — `detectWatchedChanges`의 `"change"`와 명시적으로 구별된다. */
  kind: "baseline";
}

/**
 * 최초 저장 시의 기준점 행(design.md D2). `kind: "baseline"`으로 실제 변경과 명시적으로
 * 구별되고(finding 1 — 이전에는 `old_value = NULL`이 이 구별의 유일한 마커였는데, 값이
 * 없던 필드에 값이 처음 생기는 실제 변경도 `old_value = NULL`이라 기준점과 섞였다),
 * 값이 NULL인 필드는 기준점 자체를 만들지 않는다(값 없는 무의미한 행을 막기 위함).
 */
function baselineWatchedChanges(incoming: AuctionItemInput): BaselineChange[] {
  const changes: BaselineChange[] = [];
  for (const def of WATCHED_FIELD_DEFS) {
    const value: FieldValue = incoming[def.field];
    if (value === null) continue;
    changes.push({ field: def.field, newValue: String(value), kind: "baseline" });
  }
  return changes;
}

const ANALYZED_EXISTS = "EXISTS (SELECT 1 FROM analyses WHERE analyses.item_id = items.id)";

/**
 * 재분석 대상 판정 SQL (design.md D4, 코드 리뷰 finding 2로 수정).
 *
 * **분석 행이 반드시 존재해야 한다(`ANALYZED_EXISTS`)** — 이전 버전은 "분석 행이 아예
 * 없음"도 이 OR의 한 갈래(조건 1)로 넣어서, 미분석 물건이 `needsAnalysis=true` 결과에
 * 섞여 들어왔다. 그 물건들은 재분석 후보 정렬(`analyzed_at ASC`)에서 NULL로 취급되고
 * SQLite는 ASC에서 NULL을 맨 앞에 두므로, 미분석 물건이 쌓여 있으면 재분석 페이지
 * (`pageSize`가 작다, design.md D5)가 전부 미분석 물건으로 채워지고 실제 재분석 대상은
 * 영영 조회되지 않았다 — 워커의 신규/재분석 두 조회가 페이지 크기·정렬 기준이 달라
 * dedupe로도 못 걸러냈다(workers/analyzer.ts). 미분석 물건은 `analyzed=false` 경로가
 * 전담하고, 이 조건은 "이미 분석된 적 있는 물건 중에서" 재분석이 필요한지만 본다
 * (스펙: 재분석 대상 조회는 아직 한 번도 분석되지 않은 물건을 포함해서는 안 된다).
 *
 * 분석 행이 있다는 전제 아래 남은 두 조건의 OR:
 * 1) 최신 분석 이후에 **실제** 변경(`kind = 'change'` — 기준점 제외)이 있음
 * 2) 최신 분석의 `prompt_version`이 요청된 `@promptVersion`과 다름(같음/다름만 본다 —
 *    세만틱 버전 비교를 하지 않는 이유는 design.md D4에 기록돼 있다)
 *
 * 그리고 쿨다운(코드 리뷰 finding 3, 스펙 개정 "최소 재분석 간격"): 최신 분석이
 * `@cooldownBefore`보다 최근이면(= 아직 쿨다운 중이면) 위 두 조건과 무관하게 대상에서
 * 제외한다. `@cooldownBefore`가 NULL이면(쿨다운 미적용, 호출자가 `reanalysisCooldownHours`를
 * 안 준 경우) 이 조건 자체를 건너뛴다 — `buildFilter`가 항상 이 파라미터를 바인딩한다
 * (쿨다운 미적용일 때도 NULL로).
 *
 * "최신 분석"의 기준(`analyzed_at DESC, id DESC`)은 `getLatestAnalysis`와 같다.
 * 변경 비교는 `>` (초과)를 쓴다 — 최신 분석과 같은 시각이거나 그 이전 변경은 이미 그
 * 분석에 반영됐다고 본다(경계 포함이면 분석 직후의 자기 자신 이력까지 재분석 대상으로
 * 오판할 수 있다).
 *
 * `@promptVersion`/`@cooldownBefore` 바인딩이 필요하다 — 없으면 `buildFilter`가 미리 막는다.
 */
const NEEDS_ANALYSIS_PREDICATE = `(
  ${ANALYZED_EXISTS}
  AND (
    EXISTS (
      SELECT 1 FROM item_changes nc
      WHERE nc.item_id = items.id
        AND nc.kind = 'change'
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
  )
  AND (
    @cooldownBefore IS NULL
    OR (
      SELECT nca.analyzed_at FROM analyses nca
      WHERE nca.item_id = items.id
      ORDER BY nca.analyzed_at DESC, nca.id DESC
      LIMIT 1
    ) <= @cooldownBefore
  )
)`;

/**
 * 재분석 후보 정렬: 가장 오래 전에 분석된 것 우선(`analyzed_at ASC`, design.md D5) —
 * 최신 변경 우선으로 하면 자주 바뀌는 물건이 재분석 한도를 독점한다.
 *
 * finding 2 수정 이후로는 `NEEDS_ANALYSIS_PREDICATE`가 분석 행이 있는 물건만 통과시키므로
 * 이 서브쿼리가 NULL을 낼 일이 없다(모든 후보가 최소 1건의 분석을 갖는다) — 미분석 물건이
 * NULL로 ASC 맨 앞을 차지해 재분석 후보를 밀어내던 문제는 조건 자체에서 사라졌다. 워커의
 * 신규/재분석 dedupe(workers/analyzer.ts)는 이제 안전망일 뿐 정확성의 전제가 아니다.
 */
const NEEDS_ANALYSIS_ORDER = `ORDER BY (
  SELECT ord.analyzed_at FROM analyses ord
  WHERE ord.item_id = items.id
  ORDER BY ord.analyzed_at DESC, ord.id DESC
  LIMIT 1
) ASC, items.id ASC`;

/** `listItems`가 목록 행에 붙이는 "가장 최근 실제 변경 시각" 스칼라 서브쿼리(design.md D6).
 * `getItemById`도 같은 식을 쓴다(finding 5) — 두 곳이 각자 SQL을 베끼면 하나만 고쳤을 때
 * 조용히 어긋난다. */
const LAST_CHANGED_AT_EXPR = `(
  SELECT MAX(item_changes.changed_at)
  FROM item_changes
  WHERE item_changes.item_id = items.id AND item_changes.kind = 'change'
)`;

/**
 * `listItems`/`getItemById`가 목록·상세 행에 붙이는 "관심 목록에 담겼는가" 스칼라 서브쿼리
 * (add-bookmarks-and-feed, design.md D6 — `lastChangedAt`을 추가할 때와 같은 방식).
 * `WHERE`·`ORDER BY`·`total`에는 관여하지 않으므로 기존 필터·정렬 로직과 그 테스트를
 * 건드리지 않는다. "관심 물건만 보기" 필터는 이번 범위 밖이다(design.md D6) — 전용 페이지
 * (`/bookmarks`)가 그 역할을 한다.
 */
const BOOKMARKED_EXPR = `(
  EXISTS (SELECT 1 FROM bookmarks WHERE bookmarks.item_id = items.id)
)`;

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
type BindParams = Record<string, string | number | null>;

/**
 * 재분석 쿨다운(시간)을 "이 시각 이전에 분석됐어야 재분석 대상"이라는 절대 시각 문자열로
 * 바꾼다(finding 3). ISO 8601 문자열끼리는 사전식 비교가 시간 순서와 같으므로(이 프로젝트가
 * 이미 `changed_at`/`analyzed_at` 비교에 쓰는 방식과 동일하다) SQL에서는 문자열 비교만 하면
 * 된다 — SQLite의 `datetime('now', ...)` 수정자에 기대지 않아 테스트에서 `now`를 주입해
 * 결정적으로 검증할 수 있다.
 */
function computeCooldownBefore(cooldownHours: number, nowIso: string): string {
  return new Date(new Date(nowIso).getTime() - cooldownHours * 60 * 60 * 1000).toISOString();
}

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
function buildFilter(query: ItemQuery, nowIso: string): Filter {
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

    // 쿨다운(finding 3). 값이 없으면(호출자가 안 줬으면) 미적용 — SQL은 항상 이 바인딩을
    // 참조하므로 명시적으로 null을 넣는다. 값이 있으면 다른 analysis 설정 필드들과
    // 마찬가지로 잘못된 값은 조용히 무시하지 않고 던진다.
    const cooldownHours = query.reanalysisCooldownHours;
    if (cooldownHours === undefined) {
      params.cooldownBefore = null;
    } else {
      if (!Number.isFinite(cooldownHours) || cooldownHours < 0) {
        throw new Error(`지원하지 않는 reanalysisCooldownHours 값: ${String(cooldownHours)}`);
      }
      params.cooldownBefore = computeCooldownBefore(cooldownHours, nowIso);
    }
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
  /**
   * `options.now`는 `needsAnalysis=true` + `reanalysisCooldownHours`(finding 3)의 쿨다운
   * 기준 시각으로만 쓰인다. 생략하면 호출 시점의 실제 현재 시각이다 — 테스트가 이 값을
   * 주입해 쿨다운 경계를 결정적으로 검증할 수 있게 하는 지점이다.
   */
  listItems(query?: ItemQuery, options?: { now?: IsoDateTime }): ListItemsResult;
  getItemById(id: number): AuctionItem | null;
  /** 저장된 물건에 실제로 존재하는 용도 목록. 중복 없이 정렬해서 돌려준다. */
  listUsageTypes(): string[];
  insertAnalysis(input: AnalysisInput, options?: { now?: IsoDateTime }): Analysis;
  getLatestAnalysis(itemId: number): Analysis | null;
  /**
   * 물건의 분석을 최신순으로 돌려준다(재분석 이력 열람용, task 6.3). 없으면 빈 배열.
   * `options.limit`을 주면 최신 것부터 그 건수만 잘라서 돌려준다(finding 3b — 물건 상세
   * 페이지가 이 한도 없이 전체를 렌더링하면, 감시 필드가 자주 뒤집히는 물건 하나가 한 달
   * 사이 수백 건의 분석을 쌓아 페이지 하나가 수 MB의 markdown 본문을 안고 무거워진다).
   * 전체 건수가 필요하면 `countAnalyses`를 따로 부른다 — 이 메서드는 "화면에 몇 건을
   * 그릴지"만 책임진다.
   */
  listAnalyses(itemId: number, options?: { limit?: number }): Analysis[];
  /** 물건의 전체 분석 건수. `listAnalyses`가 `limit`으로 잘라도 이 값은 잘리지 않는다. */
  countAnalyses(itemId: number): number;
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
  // 확장 컬럼(enrich-item-fields, design.md D1)도 신규/갱신 모두 이 문 하나로 처리한다.
  // WATCHED_FIELDS(감시 대상)에는 넣지 않는다(design.md D2) — item_changes 이력·재분석
  // 트리거와는 무관하게 최신값으로만 덮어쓴다.
  const upsertItem = db.prepare(`
    INSERT INTO items (
      court, case_no, item_no, address, usage_type, appraisal_price,
      min_bid_price, auction_date, failed_bid_count, status,
      min_area, max_area, building_description,
      min_bid_price_round1, min_bid_price_round2, min_bid_price_round3, min_bid_price_round4,
      min_bid_price_rate_round1, min_bid_price_rate_round2,
      usage_code_large, usage_code_medium, usage_code_small,
      sido, sigungu, dong, lot_number, building_name, building_unit,
      coordinate_x, coordinate_y, coordinate_level,
      auction_time, auction_place, auction_decision_date, auction_round,
      note, duplicate_case_no, merged_case_no, court_department, court_phone,
      status_code, item_status_code,
      first_seen_at, last_seen_at
    ) VALUES (
      @court, @caseNo, @itemNo, @address, @usageType, @appraisalPrice,
      @minBidPrice, @auctionDate, @failedBidCount, @status,
      @minArea, @maxArea, @buildingDescription,
      @minBidPriceRound1, @minBidPriceRound2, @minBidPriceRound3, @minBidPriceRound4,
      @minBidPriceRateRound1, @minBidPriceRateRound2,
      @usageCodeLarge, @usageCodeMedium, @usageCodeSmall,
      @sido, @sigungu, @dong, @lotNumber, @buildingName, @buildingUnit,
      @coordinateX, @coordinateY, @coordinateLevel,
      @auctionTime, @auctionPlace, @auctionDecisionDate, @auctionRound,
      @note, @duplicateCaseNo, @mergedCaseNo, @courtDepartment, @courtPhone,
      @statusCode, @itemStatusCode,
      @now, @now
    )
    ON CONFLICT (court, case_no, item_no) DO UPDATE SET
      address                   = excluded.address,
      usage_type                = excluded.usage_type,
      appraisal_price           = excluded.appraisal_price,
      min_bid_price             = excluded.min_bid_price,
      auction_date              = excluded.auction_date,
      failed_bid_count          = excluded.failed_bid_count,
      status                    = excluded.status,
      min_area                  = excluded.min_area,
      max_area                  = excluded.max_area,
      building_description      = excluded.building_description,
      min_bid_price_round1      = excluded.min_bid_price_round1,
      min_bid_price_round2      = excluded.min_bid_price_round2,
      min_bid_price_round3      = excluded.min_bid_price_round3,
      min_bid_price_round4      = excluded.min_bid_price_round4,
      min_bid_price_rate_round1 = excluded.min_bid_price_rate_round1,
      min_bid_price_rate_round2 = excluded.min_bid_price_rate_round2,
      usage_code_large          = excluded.usage_code_large,
      usage_code_medium         = excluded.usage_code_medium,
      usage_code_small          = excluded.usage_code_small,
      sido                      = excluded.sido,
      sigungu                   = excluded.sigungu,
      dong                      = excluded.dong,
      lot_number                = excluded.lot_number,
      building_name             = excluded.building_name,
      building_unit             = excluded.building_unit,
      coordinate_x              = excluded.coordinate_x,
      coordinate_y              = excluded.coordinate_y,
      coordinate_level          = excluded.coordinate_level,
      auction_time              = excluded.auction_time,
      auction_place             = excluded.auction_place,
      auction_decision_date     = excluded.auction_decision_date,
      auction_round             = excluded.auction_round,
      note                      = excluded.note,
      duplicate_case_no         = excluded.duplicate_case_no,
      merged_case_no            = excluded.merged_case_no,
      court_department          = excluded.court_department,
      court_phone               = excluded.court_phone,
      status_code               = excluded.status_code,
      item_status_code          = excluded.item_status_code,
      last_seen_at              = excluded.last_seen_at
  `);

  const selectItemById = db.prepare<{ id: number }, ItemRow>(
    `SELECT * FROM items WHERE id = @id`,
  );

  // getItemById 전용(finding 5) — listItems와 같은 lastChangedAt/bookmarked 서브쿼리를 쓴다
  // (LAST_CHANGED_AT_EXPR/BOOKMARKED_EXPR 상수를 공유해 두 곳이 어긋나지 않게 한다).
  const selectItemByIdWithLastChanged = db.prepare<{ id: number }, ItemListRow>(
    `SELECT items.*, ${LAST_CHANGED_AT_EXPR} AS last_changed_at, ${BOOKMARKED_EXPR} AS bookmarked
     FROM items WHERE items.id = @id`,
  );

  const insertItemChange = db.prepare(`
    INSERT INTO item_changes (item_id, field, old_value, new_value, changed_at, kind)
    VALUES (@itemId, @field, @oldValue, @newValue, @changedAt, @kind)
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

  // finding 3b: `limit`을 항상 바인딩한다 — SQLite는 `LIMIT -1`을 "제한 없음"으로
  // 처리하므로, limit 옵션이 없는 기존 호출(`listAnalyses(itemId)`)은 그대로 전체를 받는다.
  const selectAnalysesLimited = db.prepare<{ itemId: number; limit: number }, AnalysisRow>(`
    SELECT * FROM analyses
    WHERE item_id = @itemId
    ORDER BY analyzed_at DESC, id DESC
    LIMIT @limit
  `);

  const selectAnalysesCount = db.prepare<{ itemId: number }, { count: number }>(`
    SELECT COUNT(*) AS count FROM analyses WHERE item_id = @itemId
  `);

  const selectUsageTypes = db.prepare<[], { usage_type: string }>(`
    SELECT DISTINCT usage_type FROM items
    WHERE usage_type IS NOT NULL
    ORDER BY usage_type
  `);

  /** 자연 키를 배치 내 중복 감지용 문자열로 합친다. items UNIQUE (court, case_no, item_no)와 같은 조합. */
  function naturalKeyOf(item: Pick<AuctionItemInput, "court" | "caseNo" | "itemNo">): string {
    return `${item.court} ${item.caseNo} ${item.itemNo}`;
  }

  /**
   * 한 자연 키가 이 배치 안에서 어떤 상태로 시작했는지(finding 6).
   *
   * `existedBeforeBatch`가 false면 이 물건은 배치가 시작하기 전에는 존재하지 않았다 —
   * 배치 안에서 같은 키가 여러 번 나와 중간값이 여러 번 바뀌어도(예: insert 후 곧바로
   * update), 그건 전부 "신규"의 연장일 뿐 "배치 시작 전 저장값 대비 변경"이 아니므로
   * `changed`에 세지 않는다(design D3: 신규는 `inserted`가 이미 센다). `baseline`은
   * `existedBeforeBatch`가 true일 때만 의미가 있고, 그 배치 시작 시점의 실제 저장값이다.
   */
  interface KeyState {
    existedBeforeBatch: boolean;
    baseline?: ExistingItemRow;
    itemId: number;
    /** 이 키로 배치 안에서 마지막으로 처리된 입력값 — 최종적으로 DB에 남는 값이다. */
    finalItem: AuctionItemInput;
  }

  const upsertBatch = db.transaction(
    (items: AuctionItemInput[], now: string): UpsertItemsResult => {
      let inserted = 0;
      let updated = 0;
      const keyStates = new Map<string, KeyState>();

      for (const item of items) {
        // 먼저 존재 여부와 감시 필드의 저장 전 값을 본다. ON CONFLICT는 신규/갱신 모두
        // changes=1이라 그것만으로는 구분할 수 없다. 감시 필드 비교는 upsertItem이
        // 덮어쓰기 **전**에만 가능하다(design.md D3) — 그래서 별도 쿼리로 빼지 않고 이
        // 사전 SELECT를 확장했다. 이 `existing`은 "이 행을 처리하기 직전의 저장값"이라
        // 배치 안에 같은 키가 여러 번 나오면 두 번째 이후는 첫 번째 처리 결과를 보게
        // 된다 — 그래서 이력(item_changes) 기록은 이 값을 그대로 쓰지만(기존 동작
        // 유지), `changed` 집계는 아래에서 배치 시작 전 스냅숏(`keyStates`)을 따로 써서
        // 이 문제를 피한다.
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
          // 확장 필드는 AuctionItemInput에서 optional이다(이 change의 범위 밖인
          // workers/**·src/app/**의 기존 리터럴이 이 필드들을 아예 모른 채로 계속
          // 컴파일돼야 하기 때문 — src/lib/domain/types.ts 주석 참조). better-sqlite3는
          // undefined를 바인딩하면 던지므로 여기서 `?? null`로 명시적으로 접는다.
          minArea: item.minArea ?? null,
          maxArea: item.maxArea ?? null,
          buildingDescription: item.buildingDescription ?? null,
          minBidPriceRound1: item.minBidPriceRound1 ?? null,
          minBidPriceRound2: item.minBidPriceRound2 ?? null,
          minBidPriceRound3: item.minBidPriceRound3 ?? null,
          minBidPriceRound4: item.minBidPriceRound4 ?? null,
          minBidPriceRateRound1: item.minBidPriceRateRound1 ?? null,
          minBidPriceRateRound2: item.minBidPriceRateRound2 ?? null,
          usageCodeLarge: item.usageCodeLarge ?? null,
          usageCodeMedium: item.usageCodeMedium ?? null,
          usageCodeSmall: item.usageCodeSmall ?? null,
          sido: item.sido ?? null,
          sigungu: item.sigungu ?? null,
          dong: item.dong ?? null,
          lotNumber: item.lotNumber ?? null,
          buildingName: item.buildingName ?? null,
          buildingUnit: item.buildingUnit ?? null,
          coordinateX: item.coordinateX ?? null,
          coordinateY: item.coordinateY ?? null,
          coordinateLevel: item.coordinateLevel ?? null,
          auctionTime: item.auctionTime ?? null,
          auctionPlace: item.auctionPlace ?? null,
          auctionDecisionDate: item.auctionDecisionDate ?? null,
          auctionRound: item.auctionRound ?? null,
          note: item.note ?? null,
          duplicateCaseNo: item.duplicateCaseNo ?? null,
          mergedCaseNo: item.mergedCaseNo ?? null,
          courtDepartment: item.courtDepartment ?? null,
          courtPhone: item.courtPhone ?? null,
          statusCode: item.statusCode ?? null,
          itemStatusCode: item.itemStatusCode ?? null,
          now,
        });

        let itemId: number;
        if (existing) {
          updated += 1;
          itemId = existing.id;
          for (const diff of detectWatchedChanges(existing, item)) {
            insertItemChange.run({
              itemId,
              field: diff.field,
              oldValue: diff.oldValue,
              newValue: diff.newValue,
              changedAt: now,
              kind: diff.kind,
            });
          }
        } else {
          inserted += 1;
          itemId = Number(info.lastInsertRowid);
          for (const baseline of baselineWatchedChanges(item)) {
            insertItemChange.run({
              itemId,
              field: baseline.field,
              oldValue: null,
              newValue: baseline.newValue,
              changedAt: now,
              kind: baseline.kind,
            });
          }
        }

        const key = naturalKeyOf(item);
        const state = keyStates.get(key);
        if (state === undefined) {
          keyStates.set(key, {
            existedBeforeBatch: Boolean(existing),
            baseline: existing,
            itemId,
            finalItem: item,
          });
        } else {
          state.finalItem = item;
        }
      }

      // changed는 "물건 수"다(변경 이력 행 수가 아니다) — 그리고 "이 배치가 시작하기 전에
      // 이미 있던 물건인데, 배치가 끝난 뒤 최종값이 그 시작 전 값과 실제로 다른가"만 본다.
      // 이렇게 하면 같은 배치 안에 같은 키가 몇 번 나오든(finding 6) 물건당 한 번만 세고,
      // 배치 안에서 새로 생긴 물건은 중간에 값이 몇 번 바뀌어도 절대 세지 않는다(신규는
      // inserted가 이미 센다, design.md D3).
      let changed = 0;
      for (const state of keyStates.values()) {
        if (!state.existedBeforeBatch) continue;
        if (detectWatchedChanges(state.baseline!, state.finalItem).length > 0) changed += 1;
      }

      return { inserted, updated, changed };
    },
  );

  return {
    upsertItems(items, options) {
      if (items.length === 0) return { inserted: 0, updated: 0, changed: 0 };
      return upsertBatch(items, options?.now ?? new Date().toISOString());
    },

    listItems(query = {}, options) {
      const page = normalizePage(query.page);
      const pageSize = normalizePageSize(query.pageSize);
      const nowIso = options?.now ?? new Date().toISOString();
      const filter = buildFilter(query, nowIso);
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
      // "최근 변경 시각"·"관심 여부"는 스칼라 서브쿼리 컬럼으로만 추가한다(design.md D6) —
      // WHERE/ORDER BY/total(위)에는 관여하지 않아 기존 필터·정렬 로직을 건드리지 않는다.
      // 기준점 행은 실제 변경이 아니므로 LAST_CHANGED_AT_EXPR이 이미 제외한다.
      const rows = db
        .prepare<BindParams, ItemListRow>(
          `SELECT items.*, ${LAST_CHANGED_AT_EXPR} AS last_changed_at, ${BOOKMARKED_EXPR} AS bookmarked
           FROM items ${filter.where} ${orderBy} LIMIT @limit OFFSET @offset`,
        )
        .all({
          ...filter.params,
          limit: pageSize,
          offset: (page - 1) * pageSize,
        });

      return {
        items: rows.map((row) => toAuctionItem(row, row.last_changed_at, row.bookmarked)),
        total,
        page,
        pageSize,
      };
    },

    getItemById(id) {
      // listItems와 같은 lastChangedAt/bookmarked 서브쿼리를 쓴다(finding 5, add-bookmarks-
      // and-feed) — 이전에는 이 메서드만 `selectItemById`(서브쿼리 없음)를 써서 항상 null을
      // 돌려줬고, `GET /api/items/[id]`가 그 값을 그대로 노출해 단일 물건 조회에서만
      // lastChangedAt이 항상 null로 보였다 — bookmarked도 같은 이유로 이 조회를 거쳐야 한다.
      const row = selectItemByIdWithLastChanged.get({ id });
      return row ? toAuctionItem(row, row.last_changed_at, row.bookmarked) : null;
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

    listAnalyses(itemId, options) {
      const limit = options?.limit ?? -1; // SQLite: LIMIT -1 = 제한 없음
      return selectAnalysesLimited.all({ itemId, limit }).map(toAnalysis);
    },

    countAnalyses(itemId) {
      return selectAnalysesCount.get({ itemId })?.count ?? 0;
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

export function listItems(
  query?: ItemQuery,
  options?: { now?: IsoDateTime },
): ListItemsResult {
  return getRepository().listItems(query, options);
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

export function listAnalyses(itemId: number, options?: { limit?: number }): Analysis[] {
  return getRepository().listAnalyses(itemId, options);
}

export function countAnalyses(itemId: number): number {
  return getRepository().countAnalyses(itemId);
}

export function listItemChanges(itemId: number): ItemChange[] {
  return getRepository().listItemChanges(itemId);
}
