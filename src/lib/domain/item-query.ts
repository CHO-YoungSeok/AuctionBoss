/**
 * 물건 목록 조회 조건(`ItemQuery`)과 URL 파라미터 파서 (design.md D1/D4).
 *
 * API 라우트(`GET /api/items`)와 목록 페이지(서버 컴포넌트)가 **같은 파서**를 쓴다.
 * 두 곳에서 따로 파싱하면 동작이 갈라지므로 규칙은 이 파일에만 있다.
 *
 * ## 입력 형태 (정규화 진입점 하나)
 *
 * `SearchParamsLike` = `URLSearchParams` 또는 `Record<string, string | string[] | undefined>`.
 * 후자는 Next.js 서버 컴포넌트의 `searchParams`가 주는 형태다. 두 형태를 구분하는 분기는
 * `readParam()` 한 곳에만 있고, 그 뒤 파싱은 단일 경로다.
 *
 * 정규화 규칙:
 * - 값은 앞뒤 공백을 제거하고, **빈 문자열은 "없음"으로 취급**한다. HTML form은 비어 있는
 *   입력칸도 `minPrice=`처럼 보내기 때문에, 이걸 오류로 보면 폼 제출이 항상 400이 된다.
 * - 스칼라 파라미터가 여러 번 오면 첫 값만 쓴다.
 * - 모르는 파라미터 이름은 무시한다(`utm_*` 같은 것이 붙어도 400이 되면 안 된다).
 *   스펙이 400을 요구하는 것은 "인식할 수 없는 **값**"이다.
 *
 * ## strict / lenient
 *
 * - `parseItemQuery()` — 잘못된 값을 이유와 함께 거부한다. API가 400을 만드는 데 쓴다.
 * - `parseItemQueryLenient()` — 잘못된 파라미터만 버리고 기본값으로 복구한다. 페이지에 쓴다.
 *
 * 이 비대칭은 의도적이다(design.md D4): 워커 같은 API 클라이언트는 오타를 알아야 하지만,
 * 사람이 URL을 손으로 고쳤을 때 화면이 500/400으로 죽는 것은 나쁘다. lenient는 strict를
 * 다시 호출하는 방식으로 구현하므로 검증 규칙이 두 벌 존재하지 않는다.
 */
import { z } from "zod";

import type { Won } from "./types";

/** 정렬 기준. SQL 표현식 매핑은 저장소(`src/lib/db/repository.ts`)가 갖는다. */
export const SORT_KEYS = ["auctionDate", "minBidPrice", "bidRatio", "failedBidCount"] as const;
export type SortKey = (typeof SORT_KEYS)[number];

export const SORT_DIRECTIONS = ["asc", "desc"] as const;
export type SortDirection = (typeof SORT_DIRECTIONS)[number];

/**
 * 정렬 기준·방향의 기본값. 생략 시 이 값으로 동작한다(기존 동작: 매각기일 오름차순).
 *
 * 저장소(`orderByClause`의 기본값)와 UI(폼의 초기 선택값, 목록 헤더의 라벨)가 각자
 * 하드코딩하면 하나만 바꿔 셋이 어긋난다. 이 상수 하나만 바꾸면 셋이 같이 바뀐다.
 */
export const DEFAULT_SORT_KEY: SortKey = SORT_KEYS[0];
export const DEFAULT_SORT_DIRECTION: SortDirection = SORT_DIRECTIONS[0];

/** 기본 페이지 크기. 파서와 저장소가 같은 값을 쓴다. */
export const DEFAULT_PAGE_SIZE = 20;
/** 한 번에 가져올 수 있는 최대 건수. 이보다 큰 `pageSize`는 strict에서 거부된다. */
export const MAX_PAGE_SIZE = 200;
/**
 * `usage` 반복 파라미터가 가질 수 있는 최대 개수.
 *
 * 저장소는 값 하나당 바인딩 파라미터 하나를 만든다(`repository.ts`의 `buildFilter`).
 * SQLite의 바인딩 파라미터 개수에는 상한이 있어(`SQLITE_MAX_VARIABLE_NUMBER`), 그 이상은
 * `db.prepare`가 던지고 API는 이를 500으로 흘려보낸다. 실제로 저장된 용도 종류는 많아야
 * 수십 개이므로, 여유를 두고 여기서 400으로 먼저 걸러 방어한다.
 */
export const MAX_USAGE_TYPES = 50;

/**
 * 목록 조회 조건. 새 필드는 전부 optional이며, 생략하면 이 변경 이전과 동일하게 동작한다
 * (분석 워커가 `{ analyzed: false, pageSize: N }`으로 호출하는 계약을 깨지 않기 위함).
 */
export interface ItemQuery {
  /** 1부터 시작. 기본 1. */
  page?: number;
  /** 기본 `DEFAULT_PAGE_SIZE`, 최대 `MAX_PAGE_SIZE`. */
  pageSize?: number;
  /** `false`=분석 결과가 없는 물건만, `true`=있는 물건만, 생략=전체 */
  analyzed?: boolean;
  /** 용도. 하나라도 일치하면 통과(OR). 저장된 값과 **정확히** 일치해야 한다. */
  usageTypes?: string[];
  /** 최저매각가격 하한(원, 포함). 최저매각가격이 없는(NULL) 물건은 제외된다. */
  minPrice?: Won;
  /** 최저매각가격 상한(원, 포함). */
  maxPrice?: Won;
  /** 유찰횟수 하한(포함). 유찰횟수가 없는(NULL) 물건은 제외된다. */
  minFailedBidCount?: number;
  /** 소재지 부분 일치 키워드. */
  addressKeyword?: string;
  /** 생략하면 매각기일 정렬(기존 기본 동작). */
  sort?: SortKey;
  /** 생략하면 오름차순. */
  direction?: SortDirection;
}

/**
 * URL 파라미터 이름 (design.md D4).
 *
 * `usage`만 **반복 파라미터**(`usage=a&usage=b`)다 — 아래 주석 참조.
 */
export const ITEM_QUERY_PARAMS = [
  "page",
  "pageSize",
  "analyzed",
  "usage",
  "minPrice",
  "maxPrice",
  "minFailed",
  "q",
  "sort",
  "dir",
] as const;

export type ItemQueryParam = (typeof ITEM_QUERY_PARAMS)[number];

/**
 * 여러 값을 받는 파라미터.
 *
 * ⚠️ design.md D4는 `usage`를 쉼표 구분 단일 파라미터로 정했고, 그 전제를
 * "용도 문자열에 쉼표가 없다"로 적으면서 "구현 시 확인하고 있으면 인코딩을 바꾼다"고 했다.
 * 확인 결과 **전제가 틀렸다**: 실측 데이터(`src/lib/sources/courtauction/NOTES.md` §8,
 * 2026-09-06 실제 응답 10행 중 6행)의 `dspslUsgNm`이 `"상가,오피스텔,근린시설"`이다.
 * 쉼표로 나누면 존재하지 않는 용도 3개가 되어 아무 것도 매칭되지 않는다.
 * 그래서 D4의 지시대로 인코딩을 **반복 파라미터**로 바꿨다. D4가 쉼표를 택한 이유
 * (서버 컴포넌트의 `string | string[]` 분기)는 이 파일의 `readParam()`이 그 분기를
 * 한 곳에 흡수하므로 사라진다. HTML 체크박스 그룹이 그대로 반복 파라미터를 보내므로
 * UI 쪽도 오히려 단순해진다.
 */
const MULTI_VALUE_PARAMS: ReadonlySet<string> = new Set<ItemQueryParam>(["usage"]);

/** 서버 컴포넌트의 `searchParams`와 `URLSearchParams`를 함께 받는다. */
export type SearchParamsLike =
  | URLSearchParams
  | Readonly<Record<string, string | string[] | undefined>>;

/** 정규화된 원시 파라미터. zod 스키마의 입력 형태이자 lenient 재시도의 작업 단위. */
interface RawItemQueryParams {
  page?: string;
  pageSize?: string;
  analyzed?: string;
  usage?: string[];
  minPrice?: string;
  maxPrice?: string;
  minFailed?: string;
  q?: string;
  sort?: string;
  dir?: string;
}

/**
 * `URLSearchParams` / 레코드 두 형태를 흡수하는 유일한 지점.
 *
 * 값은 앞뒤 공백을 트림하되, **빈 문자열은 그대로 남긴다** — "파라미터가 아예 없음"과
 * "파라미터가 빈 값으로 있음"을 호출자(`normalizeParams`)가 구분할 수 있어야 하기 때문이다.
 * strict와 lenient가 이 둘을 다르게 다룬다(아래 `normalizeParams` 참조).
 */
function readParam(input: SearchParamsLike, name: string): string[] {
  const raw = input instanceof URLSearchParams ? input.getAll(name) : input[name];
  if (raw === undefined || raw === null) return [];
  const values = Array.isArray(raw) ? raw : [raw];
  return values
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim());
}

interface NormalizeOptions {
  /**
   * true(lenient): 빈 값은 "없음"으로 취급해 조용히 제거한다 — HTML form은 비어 있는
   * 입력칸도 `minPrice=`처럼 보내므로, 페이지에서 이걸 오류로 보면 폼 제출이 항상
   * 기본값 복구 대상이 되어 버린다(사람이 쓰는 화면에서는 그게 맞는 동작이다).
   *
   * false(strict): 빈 값은 "이 파라미터가 잘못됨" 이슈로 남긴다 — API 클라이언트가
   * `?analyzed=`처럼 인식된 파라미터를 빈 값으로 보내는 것은 폼 제출이 아니라 버그일
   * 가능성이 높고(예: 빈 문자열이 될 수 있는 변수를 그대로 쿼리스트링에 넣은 경우),
   * 조용히 "그 조건 없음"으로 넘어가면 정반대의 결과(예: 분석된/안 된 물건이 뒤섞여
   * 반환됨)를 아무 경고 없이 돌려주게 된다. HTML form은 애초에 lenient 파서만 쓰므로
   * (design.md D4) 이 엄격함이 폼 제출에 영향을 주지 않는다.
   */
  emptyMeansAbsent: boolean;
}

interface NormalizedParams {
  params: RawItemQueryParams;
  /** strict에서만 채워진다. 빈 값으로 온 인식된 파라미터 목록. */
  emptyIssues: ItemQueryIssue[];
}

function normalizeParams(input: SearchParamsLike, options: NormalizeOptions): NormalizedParams {
  const collected: Record<string, string | string[]> = {};
  const emptyIssues: ItemQueryIssue[] = [];

  for (const name of ITEM_QUERY_PARAMS) {
    const values = readParam(input, name);
    if (values.length === 0) continue; // 파라미터 자체가 없다 — 이건 항상 "없음"이다

    if (options.emptyMeansAbsent) {
      const nonEmpty = values.filter((value) => value !== "");
      if (nonEmpty.length === 0) continue; // 전부 빈 값 → 없음과 동일하게 취급
      collected[name] = MULTI_VALUE_PARAMS.has(name) ? nonEmpty : nonEmpty[0];
      continue;
    }

    // strict: 값 중 하나라도 비어 있으면 그 파라미터 전체를 오류로 남기고 스키마에는
    // 아예 넘기지 않는다 — 절반만 반영하면 사용자가 지정하지 않은 조건을 만들어 낸다.
    if (values.some((value) => value === "")) {
      emptyIssues.push({ field: name, message: `${name} 값은 비어 있을 수 없습니다` });
      continue;
    }
    collected[name] = MULTI_VALUE_PARAMS.has(name) ? values : values[0];
  }

  // 키 이름과 다중값 여부는 위 루프가 보장하므로 여기서 한 번만 형태를 확정한다.
  return { params: collected as RawItemQueryParams, emptyIssues };
}

/** `^\d+$`만 통과시키고 숫자로 바꾼다. 음수·소수·공백은 전부 거부된다. */
function integerParam(label: string) {
  return z
    .string()
    .regex(/^\d+$/, `${label}은(는) 정수여야 합니다`)
    .transform((value) => Number(value))
    .refine(Number.isSafeInteger, `${label}이(가) 너무 큽니다`);
}

/**
 * 파라미터 검증 스키마. 필드 이름은 **URL 파라미터 이름**이다 — 오류 경로가 곧
 * "어떤 파라미터가 잘못됐는지"가 되고, lenient가 그 이름으로 파라미터를 버릴 수 있다.
 */
const itemQueryParamsSchema = z
  .object({
    page: integerParam("page")
      .refine((value) => value >= 1, "page는 1 이상이어야 합니다")
      .optional(),
    pageSize: integerParam("pageSize")
      .refine((value) => value >= 1, "pageSize는 1 이상이어야 합니다")
      .refine((value) => value <= MAX_PAGE_SIZE, `pageSize는 ${MAX_PAGE_SIZE} 이하여야 합니다`)
      .optional(),
    analyzed: z
      .enum(["true", "false"], {
        errorMap: () => ({ message: "analyzed는 true 또는 false여야 합니다" }),
      })
      .transform((value) => value === "true")
      .optional(),
    // 정규화 단계에서 빈 값이 걸러지므로(lenient) 또는 이슈로 남으므로(strict) 여기서는
    // 방어적 확인만 한다. 개수 상한(`MAX_USAGE_TYPES`)은 SQLite 바인딩 파라미터 상한에
    // 걸리기 전에 400으로 거절하기 위한 방어선이다.
    usage: z
      .array(z.string().min(1, "usage 값은 비어 있을 수 없습니다"))
      .min(1)
      .max(MAX_USAGE_TYPES, `usage는 한 번에 ${MAX_USAGE_TYPES}개 이하만 지정할 수 있습니다`)
      .optional(),
    minPrice: integerParam("minPrice").optional(),
    maxPrice: integerParam("maxPrice").optional(),
    minFailed: integerParam("minFailed").optional(),
    q: z.string().min(1).optional(),
    sort: z
      .enum(SORT_KEYS, {
        errorMap: () => ({ message: `sort는 ${SORT_KEYS.join(", ")} 중 하나여야 합니다` }),
      })
      .optional(),
    dir: z
      .enum(SORT_DIRECTIONS, {
        errorMap: () => ({ message: "dir는 asc 또는 desc여야 합니다" }),
      })
      .optional(),
  })
  .superRefine((params, ctx) => {
    if (params.minPrice === undefined || params.maxPrice === undefined) return;
    if (params.minPrice <= params.maxPrice) return;
    // 두 파라미터 각각에 오류를 붙인다. strict는 둘 다 알려주고, lenient는 이 경로를 보고
    // **둘 다 버린다** — 한쪽만 남기면 사용자가 지정하지 않은 범위를 임의로 만들어 낸다.
    //
    // 주의: 이건 이 교차검증 하나가 두 필드에 이슈를 "의도적으로" 복제하는 경우다.
    // 서로 무관한 필드가 각자 잘못된 경우(예: `{sort:"nope", minPrice:500, maxPrice:100}`)는
    // 이 얘기가 아니다 — zod의 `object()`는 필드 단위 검증(`sort`)에서 이미 실패한 값을
    // `superRefine`에 아예 넘기지 않으므로, 그 조합에서는 `sort` 이슈만 보이고 이 교차검증은
    // 실행조차 되지 않는다(minPrice/maxPrice 이슈는 나타나지 않는다). "여러 파라미터가 동시에
    // 잘못되면 전부 알려준다"는 필드 단위 오류끼리의 얘기이지, 필드 단위 오류와 이 교차검증이
    // 항상 함께 보고된다는 뜻이 아니다.
    for (const name of ["minPrice", "maxPrice"] as const) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [name],
        message: "minPrice는 maxPrice보다 클 수 없습니다",
      });
    }
  });

type ParsedItemQueryParams = z.output<typeof itemQueryParamsSchema>;

/** 검증이 끝난 파라미터를 도메인 조건으로 옮긴다. 없는 조건은 키 자체를 두지 않는다. */
function toItemQuery(params: ParsedItemQueryParams): ItemQuery {
  const query: ItemQuery = {
    // page/pageSize는 항상 값이 있어야 호출자가 페이지네이션을 계산할 수 있다.
    page: params.page ?? 1,
    pageSize: params.pageSize ?? DEFAULT_PAGE_SIZE,
  };
  if (params.analyzed !== undefined) query.analyzed = params.analyzed;
  if (params.usage !== undefined) query.usageTypes = params.usage;
  if (params.minPrice !== undefined) query.minPrice = params.minPrice;
  if (params.maxPrice !== undefined) query.maxPrice = params.maxPrice;
  if (params.minFailed !== undefined) query.minFailedBidCount = params.minFailed;
  if (params.q !== undefined) query.addressKeyword = params.q;
  if (params.sort !== undefined) query.sort = params.sort;
  if (params.dir !== undefined) query.direction = params.dir;
  return query;
}

/** 파라미터 이름과 사람이 읽을 수 있는 이유. API 400 응답의 `details` 항목이 된다. */
export interface ItemQueryIssue {
  field: string;
  message: string;
}

export type ItemQueryParseResult =
  | { success: true; query: ItemQuery }
  | { success: false; issues: ItemQueryIssue[] };

function isItemQueryParam(value: unknown): value is ItemQueryParam {
  return typeof value === "string" && (ITEM_QUERY_PARAMS as readonly string[]).includes(value);
}

function toIssues(error: z.ZodError): ItemQueryIssue[] {
  return error.issues.map((issue) => ({
    field: issue.path.length > 0 ? String(issue.path[0]) : "(root)",
    message: issue.message,
  }));
}

/**
 * strict 파서. 잘못된 값이 있으면 어떤 파라미터가 문제인지와 함께 실패를 돌려준다.
 * API가 400을 만드는 데 쓴다.
 *
 * 인식된 파라미터가 **빈 값**(공백만 있는 값 포함)으로 온 것도 실패로 본다
 * (`normalizeParams`의 `emptyMeansAbsent: false`). `?analyzed=`처럼 값이 빈 채로
 * 오면 이전에는 "analyzed 없음"과 같은 결과(전체 반환)로 조용히 넘어갔는데, 이건
 * 그 파라미터의 의미를 정반대로 뒤집는 결과라 400으로 알려야 한다. 이 엄격함은
 * lenient(페이지)에는 적용되지 않는다 — HTML form은 애초에 lenient만 쓴다(design.md D4).
 */
export function parseItemQuery(input: SearchParamsLike): ItemQueryParseResult {
  const { params, emptyIssues } = normalizeParams(input, { emptyMeansAbsent: false });
  const result = itemQueryParamsSchema.safeParse(params);

  if (!result.success) {
    return { success: false, issues: [...emptyIssues, ...toIssues(result.error)] };
  }
  if (emptyIssues.length > 0) {
    return { success: false, issues: emptyIssues };
  }
  return { success: true, query: toItemQuery(result.data) };
}

/**
 * lenient 파서. 잘못된 파라미터만 버리고 나머지는 살린다. 목록 페이지에 쓴다.
 *
 * strict를 그대로 다시 호출하는 것이 핵심이다 — 검증 규칙을 여기에 복사하지 않는다.
 * 실패한 파라미터를 지우고 재시도하며, 파라미터 수가 유한하므로 반드시 종료한다.
 *
 * 빈 값은 `normalizeParams`가 `emptyMeansAbsent: true`로 이미 "없음"으로 지웠으므로
 * (strict와 달리) 이 함수는 애초에 빈 값 이슈를 보지 않는다.
 */
export function parseItemQueryLenient(input: SearchParamsLike): ItemQuery {
  let params = normalizeParams(input, { emptyMeansAbsent: true }).params;

  // 한 번 돌 때마다 파라미터가 최소 하나 줄어들므로 최대 (파라미터 수 + 1)회면 끝난다.
  for (let attempt = 0; attempt <= ITEM_QUERY_PARAMS.length; attempt += 1) {
    const result = itemQueryParamsSchema.safeParse(params);
    if (result.success) return toItemQuery(result.data);

    const rejected = result.error.issues
      .map((issue) => issue.path[0])
      .filter(isItemQueryParam)
      .filter((name) => params[name] !== undefined);

    // 어느 파라미터 탓인지 짚을 수 없으면 더 시도해도 같은 결과다 → 전부 버린다.
    if (rejected.length === 0) break;
    params = { ...params };
    for (const name of rejected) delete params[name];
  }

  return toItemQuery({});
}

/**
 * 필터·정렬이 하나라도 걸려 있는지 — 즉 이 조건이 결과를 조금이라도 좁히는지.
 *
 * UI가 "필터 초기화" 링크를 보여줄지, 그리고 목록 페이지가 "DB가 비었다"와 "조건에
 * 걸리는 물건이 없다"를 구분할지(`chooseEmptyState`) 판단하는 **단일 기준**이다.
 * 저장소의 `buildFilter`(`repository.ts`)가 SQL `WHERE`에 넣는 조건과 정확히 같은
 * 필드 목록이어야 한다 — 여기 없는 필드를 저장소가 필터로 쓰기 시작하면, 그 필터가
 * 결과를 0건으로 좁혀도 화면은 "DB가 비었다"는 틀린 안내를 하게 된다(실제로
 * `analyzed`가 한 번 이렇게 빠져서 사고가 났다). 새 필터 필드를 추가하면 반드시
 * 여기도 같이 고친다.
 */
export function hasActiveFilters(query: ItemQuery): boolean {
  return (
    query.analyzed !== undefined ||
    (query.usageTypes !== undefined && query.usageTypes.length > 0) ||
    query.minPrice !== undefined ||
    query.maxPrice !== undefined ||
    query.minFailedBidCount !== undefined ||
    (query.addressKeyword !== undefined && query.addressKeyword !== "")
  );
}

/**
 * 목록 페이지가 "결과 0건"을 어떻게 설명해야 하는지에 대한 판단 결과.
 *
 * - `hasItems`: 보여줄 물건이 있다. 안내 문구가 필요 없다.
 * - `emptyDatabase`: 물건이 하나도 저장되지 않았다(필터와 무관). "아직 수집된 물건이
 *   없다"가 맞는 안내이고, 필터 폼·초기화 링크는 보여줄 게 없다(고를 값 자체가 없다).
 * - `emptyFiltered`: 저장된 물건은 있지만 지금 조건에 맞는 게 없다. "조건에 맞는 물건이
 *   없다"는 안내와 함께 조건을 초기화할 수단(필터 폼, 초기화 링크)이 반드시 보여야 한다
 *   — 그렇지 않으면 사용자가 빠져나갈 방법이 없다.
 *
 * 순수 함수로 뺀 이유: 이 판단이 JSX 조건문 안에 있었을 때 `analyzed`처럼 결과를 좁히는
 * 조건 하나가 `hasActiveFilters`에서 빠진 채 방치돼도 아무 테스트도 잡아내지 못했다.
 */
export type EmptyState =
  | { kind: "hasItems" }
  | { kind: "emptyDatabase" }
  | { kind: "emptyFiltered" };

export function chooseEmptyState(total: number, query: ItemQuery): EmptyState {
  if (total > 0) return { kind: "hasItems" };
  return hasActiveFilters(query) ? { kind: "emptyFiltered" } : { kind: "emptyDatabase" };
}
