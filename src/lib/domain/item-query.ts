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

/** 기본 페이지 크기. 파서와 저장소가 같은 값을 쓴다. */
export const DEFAULT_PAGE_SIZE = 20;
/** 한 번에 가져올 수 있는 최대 건수. 이보다 큰 `pageSize`는 strict에서 거부된다. */
export const MAX_PAGE_SIZE = 200;

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

/** `URLSearchParams` / 레코드 두 형태를 흡수하는 유일한 지점. */
function readParam(input: SearchParamsLike, name: string): string[] {
  const raw = input instanceof URLSearchParams ? input.getAll(name) : input[name];
  if (raw === undefined || raw === null) return [];
  const values = Array.isArray(raw) ? raw : [raw];
  return values
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter((value) => value !== "");
}

function normalizeParams(input: SearchParamsLike): RawItemQueryParams {
  const collected: Record<string, string | string[]> = {};
  for (const name of ITEM_QUERY_PARAMS) {
    const values = readParam(input, name);
    if (values.length === 0) continue; // 없거나 빈 문자열이면 키 자체를 두지 않는다
    collected[name] = MULTI_VALUE_PARAMS.has(name) ? values : values[0];
  }
  // 키 이름과 다중값 여부는 위 루프가 보장하므로 여기서 한 번만 형태를 확정한다.
  return collected as RawItemQueryParams;
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
    // 정규화 단계에서 빈 값이 제거되므로 여기서는 방어적 확인만 한다.
    usage: z.array(z.string().min(1, "usage 값은 비어 있을 수 없습니다")).min(1).optional(),
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
 */
export function parseItemQuery(input: SearchParamsLike): ItemQueryParseResult {
  const result = itemQueryParamsSchema.safeParse(normalizeParams(input));
  if (!result.success) return { success: false, issues: toIssues(result.error) };
  return { success: true, query: toItemQuery(result.data) };
}

/**
 * lenient 파서. 잘못된 파라미터만 버리고 나머지는 살린다. 목록 페이지에 쓴다.
 *
 * strict를 그대로 다시 호출하는 것이 핵심이다 — 검증 규칙을 여기에 복사하지 않는다.
 * 실패한 파라미터를 지우고 재시도하며, 파라미터 수가 유한하므로 반드시 종료한다.
 */
export function parseItemQueryLenient(input: SearchParamsLike): ItemQuery {
  let params = normalizeParams(input);

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

/** 필터·정렬이 하나라도 걸려 있는지. UI가 "필터 초기화"를 보여줄지 판단하는 데 쓴다. */
export function hasActiveFilters(query: ItemQuery): boolean {
  return (
    (query.usageTypes !== undefined && query.usageTypes.length > 0) ||
    query.minPrice !== undefined ||
    query.maxPrice !== undefined ||
    query.minFailedBidCount !== undefined ||
    (query.addressKeyword !== undefined && query.addressKeyword !== "")
  );
}
