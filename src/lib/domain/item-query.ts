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

import type { IsoDate, Won } from "./types";

/** 정렬 기준. SQL 표현식 매핑은 저장소(`src/lib/db/repository.ts`)가 갖는다. */
export const SORT_KEYS = [
  "auctionDate",
  "minBidPrice",
  "bidRatio",
  "failedBidCount",
  "pricePerArea",
] as const;
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
/** `sido`/`sigungu` 반복 파라미터의 최대 개수. `MAX_USAGE_TYPES`와 같은 이유(SQLite 바인딩
 * 파라미터 상한 방어)로 값을 둔다 — 실제 시/도·시군구 종류는 이보다 훨씬 적다. */
export const MAX_REGION_VALUES = 50;

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
  /**
   * `true`=재분석이 필요한 물건만(design.md D4). `analyzed`와 별개의 독립된 필터다 —
   * `analyzed=false`의 의미(분석 행 없음)는 이 필드가 있어도 바뀌지 않는다.
   * 항상 `promptVersion`과 함께 와야 한다(판정 조건 3이 프롬프트 버전 비교이기 때문).
   */
  needsAnalysis?: boolean;
  /**
   * `needsAnalysis=true` 판정에 쓸 호출자의 현재 프롬프트 버전. `needsAnalysis` 없이
   * 단독으로 와도 오류는 아니지만(호출자가 다른 목적으로 보낼 수 있다) 아무 필터도
   * 걸지 않는다 — `needsAnalysis`가 있을 때만 읽힌다.
   */
  promptVersion?: string;
  /**
   * `needsAnalysis=true` 판정에 적용할 재분석 쿨다운(시간 단위, 코드 리뷰 finding 3).
   * **URL 파라미터가 아니다** — 클라이언트(분석 워커)가 마음대로 정할 수 있는 값이
   * 아니라 서버 설정(`config/collector.json`의 `analysis.reanalysisCooldownHours`)에서만
   * 온다. `GET /api/items` 라우트가 `needsAnalysis=true` 요청일 때만 이 값을 채워
   * 저장소에 넘긴다. 생략하면(직접 저장소를 호출하는 테스트 등) 쿨다운을 적용하지 않는다
   * (기존 동작과 동일).
   */
  reanalysisCooldownHours?: number;
  /**
   * 용도. 하나라도 일치하면 통과(OR). **토큰 단위 매칭이다**(design.md D2, tasks.md 5.2) —
   * 저장된 값이 복합 문자열(`"상가,오피스텔,근린시설"`)이면 쉼표로 나눈 개별 토큰 중
   * 하나라도 일치해도 통과한다. 복합 문자열 전체와 정확히 같아야 통과하던 이전 계약을
   * 깨는 **의도된 변경**이다(같은 `usage=오피스텔` 요청이 이전보다 넓은 결과를 반환한다).
   */
  usageTypes?: string[];
  /** 최저매각가격 하한(원, 포함). 최저매각가격이 없는(NULL) 물건은 제외된다. */
  minPrice?: Won;
  /** 최저매각가격 상한(원, 포함). */
  maxPrice?: Won;
  /** 유찰횟수 하한(포함). 유찰횟수가 없는(NULL) 물건은 제외된다. */
  minFailedBidCount?: number;
  /** 소재지 부분 일치 키워드. */
  addressKeyword?: string;
  /** 시/도. 하나라도 일치하면 통과(OR). 저장된 값과 정확히 일치해야 한다(`sido` 컬럼은
   * 복합 문자열이 아니다 — `usageTypes`와 다른 매칭 규칙). */
  sidoValues?: string[];
  /** 시/군/구. `sidoValues`와 같은 규칙. */
  sigunguValues?: string[];
  /** 매각기일 하한(포함, `YYYY-MM-DD`). 매각기일이 없는(NULL) 물건은 제외된다. */
  auctionDateFrom?: IsoDate;
  /** 매각기일 상한(포함). */
  auctionDateTo?: IsoDate;
  /**
   * `true`=오늘(한국 시간) 이후 매각기일만. **opt-in 전용**이다(design.md D4) — 이 필드가
   * 없으면(기본) 지난 기일 물건도 그대로 포함된다. 실데이터 389건 중 121건(31%)이 이미
   * 지난 기일이라, 이걸 기본값으로 하면 그 물건들이 조용히 사라진다.
   */
  excludePastAuctions?: boolean;
  /** `true`=관심 목록에 담긴 물건만, `false`=담기지 않은 물건만, 생략=전체. 목록 행의
   * 관심 표시(`AuctionItem.bookmarked`, 스칼라 서브쿼리)와는 별개의 `WHERE` 조건이다
   * (design.md D4 — `BOOKMARKED_EXPR`는 필터에 관여하지 않는 보장을 유지한다). */
  bookmarked?: boolean;
  /** 법원명 일치 조건 */
  court?: string;
  /** 저감률 하한 (0~100) */
  minDiscountRate?: number;
  /** 사진 보유 여부 (수집 완료된 사진) */
  hasPhotos?: boolean;
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
  "needsAnalysis",
  "promptVersion",
  "usage",
  "minPrice",
  "maxPrice",
  "minFailed",
  "q",
  "sort",
  "dir",
  "sido",
  "sigungu",
  "minEok",
  "minMan",
  "maxEok",
  "maxMan",
  "dateFrom",
  "dateTo",
  "excludePast",
  "bookmarked",
  "court",
  "minDiscountRate",
  "hasPhotos",
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
const MULTI_VALUE_PARAMS: ReadonlySet<string> = new Set<ItemQueryParam>([
  "usage",
  "sido",
  "sigungu",
]);

/** 서버 컴포넌트의 `searchParams`와 `URLSearchParams`를 함께 받는다. */
export type SearchParamsLike =
  | URLSearchParams
  | Readonly<Record<string, string | string[] | undefined>>;

/** 정규화된 원시 파라미터. zod 스키마의 입력 형태이자 lenient 재시도의 작업 단위. */
interface RawItemQueryParams {
  page?: string;
  pageSize?: string;
  analyzed?: string;
  needsAnalysis?: string;
  promptVersion?: string;
  usage?: string[];
  minPrice?: string;
  maxPrice?: string;
  minFailed?: string;
  q?: string;
  sort?: string;
  dir?: string;
  sido?: string[];
  sigungu?: string[];
  minEok?: string;
  minMan?: string;
  maxEok?: string;
  maxMan?: string;
  dateFrom?: string;
  dateTo?: string;
  excludePast?: string;
  bookmarked?: string;
  court?: string;
  minDiscountRate?: string;
  hasPhotos?: string;
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

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** `YYYY-MM-DD`만 통과시킨다. `IsoDate`(매각기일)와 같은 형식이어야 SQL 비교(`>=`/`<=`)가
 * 사전식 비교로 정확히 날짜 순서와 일치한다. */
function dateParam(label: string) {
  return z.string().regex(DATE_ONLY_PATTERN, `${label}은(는) YYYY-MM-DD 형식이어야 합니다`);
}

/** 1억 = 100,000,000원. 표시 계층(`src/app/_lib/format.ts`)도 같은 상수를 써서 파싱과
 * 표시가 어긋나지 않게 한다. */
export const WON_PER_EOK = 100_000_000;
/** 1만원 = 10,000원. */
export const WON_PER_MAN = 10_000;
const EOK_WON = WON_PER_EOK;
const MAN_WON = WON_PER_MAN;

interface EffectiveBound {
  /** 결합된 원 단위 값. min/max 어느 쪽도 지정하지 않았으면 undefined. */
  value: number | undefined;
  /** 이 값을 만든 실제 파라미터 이름들 — lenient 재시도가 지울 대상이자 strict 400의
   * `field`가 된다. */
  sourceFields: string[];
}

/**
 * `minPrice`/`maxPrice`(원 정수, 기존 계약)와 `minEok`/`minMan`(신규, 억/만원 단위)이
 * 동시에 오면 **원 단위 파라미터가 이긴다**(design.md D3 Open Question, tasks.md 2.2로
 * 여기서 확정·문서화한다). 이미 계약·테스트로 고정된 원 단위 필드가 사람 편의를 위해
 * 새로 추가한 필드 때문에 흔들리면 안 된다는 판단이다. eok/man 중 하나만 와도 나머지는
 * 0으로 본다(예: 만원 단위만 입력).
 */
function effectivePriceBound(
  rawValue: number | undefined,
  eok: number | undefined,
  man: number | undefined,
  rawField: "minPrice" | "maxPrice",
  eokField: "minEok" | "maxEok",
  manField: "minMan" | "maxMan",
): EffectiveBound {
  if (rawValue !== undefined) return { value: rawValue, sourceFields: [rawField] };
  if (eok === undefined && man === undefined) return { value: undefined, sourceFields: [] };
  const sourceFields: string[] = [];
  if (eok !== undefined) sourceFields.push(eokField);
  if (man !== undefined) sourceFields.push(manField);
  return { value: (eok ?? 0) * EOK_WON + (man ?? 0) * MAN_WON, sourceFields };
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
    // "false"는 지원하지 않는다 — design.md D4가 추가하는 것은 "재분석이 필요한
    // 물건만" 걸러내는 필터 하나뿐이고, "재분석이 필요 없는 물건만"이라는 반대
    // 방향의 질의는 이 변경의 요구사항에 없다.
    needsAnalysis: z
      .enum(["true"], {
        errorMap: () => ({ message: "needsAnalysis는 true만 지원합니다" }),
      })
      .transform(() => true)
      .optional(),
    promptVersion: z.string().min(1, "promptVersion 값은 비어 있을 수 없습니다").optional(),
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
    sido: z
      .array(z.string().min(1, "sido 값은 비어 있을 수 없습니다"))
      .min(1)
      .max(MAX_REGION_VALUES, `sido는 한 번에 ${MAX_REGION_VALUES}개 이하만 지정할 수 있습니다`)
      .optional(),
    sigungu: z
      .array(z.string().min(1, "sigungu 값은 비어 있을 수 없습니다"))
      .min(1)
      .max(MAX_REGION_VALUES, `sigungu는 한 번에 ${MAX_REGION_VALUES}개 이하만 지정할 수 있습니다`)
      .optional(),
    // 억/만원 입력(design.md D3) — minPrice/maxPrice(원 정수)와 별개로 받아 서버가 합산한다.
    // 0도 유효하다(integerParam의 `^\d+$`가 이미 허용) — "억은 0, 만원만 입력" 같은 조합.
    minEok: integerParam("minEok").optional(),
    minMan: integerParam("minMan").optional(),
    maxEok: integerParam("maxEok").optional(),
    maxMan: integerParam("maxMan").optional(),
    dateFrom: dateParam("dateFrom").optional(),
    dateTo: dateParam("dateTo").optional(),
    // "지난 기일 제외"는 opt-in 전용이라 true만 지원한다(needsAnalysis와 같은 패턴,
    // design.md D4) — false를 지원하면 "포함"이라는 반대 방향 질의가 생겨 기본 동작과
    // 헷갈린다.
    excludePast: z
      .enum(["true"], {
        errorMap: () => ({ message: "excludePast는 true만 지원합니다" }),
      })
      .transform(() => true)
      .optional(),
    bookmarked: z
      .enum(["true", "false"], {
        errorMap: () => ({ message: "bookmarked는 true 또는 false여야 합니다" }),
      })
      .transform((value) => value === "true")
      .optional(),
    court: z.string().min(1, "court 값은 비어 있을 수 없습니다").optional(),
    minDiscountRate: integerParam("minDiscountRate")
      .refine((val) => val >= 0 && val <= 100, "minDiscountRate는 0에서 100 사이여야 합니다")
      .optional(),
    hasPhotos: z
      .enum(["true", "false"], {
        errorMap: () => ({ message: "hasPhotos는 true 또는 false여야 합니다" }),
      })
      .transform((value) => value === "true")
      .optional(),
  })
  .superRefine((params, ctx) => {
    // needsAnalysis=true는 항상 promptVersion과 함께 와야 한다(design.md D4) — 판정
    // 조건 3(프롬프트 버전 비교)의 비교 대상이 없으면 무엇을 "다른 버전"으로 볼지
    // 정할 수 없다. 이슈를 needsAnalysis 쪽에 붙이는 이유: lenient가 실패한 파라미터를
    // 이름으로 지워 재시도하는데, promptVersion은 애초에 안 왔으니 params에 없어
    // 지울 대상이 못 된다 — needsAnalysis 쪽에 붙여야 lenient가 이 파라미터만 버리고
    // 나머지 필터는 살릴 수 있다.
    if (params.needsAnalysis === true && params.promptVersion === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["needsAnalysis"],
        message: "needsAnalysis=true이면 promptVersion이 함께 있어야 합니다",
      });
    }

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
  })
  .superRefine((params, ctx) => {
    // 억/만원(eok/man) 입력의 합산값도 minPrice/maxPrice와 같은 방향 검증을 받아야 한다 —
    // 안 그러면 "최소 3억, 최대 1억"처럼 뒤집힌 조건이 그대로 통과해 조용히 0건을 낸다.
    // 원 단위 파라미터끼리만 온 경우(둘 다 sourceFields가 ["minPrice"]/["maxPrice"])는
    // 바로 위 교차검증이 이미 처리했으므로 여기서 다시 보고하지 않는다.
    const minBound = effectivePriceBound(
      params.minPrice,
      params.minEok,
      params.minMan,
      "minPrice",
      "minEok",
      "minMan",
    );
    const maxBound = effectivePriceBound(
      params.maxPrice,
      params.maxEok,
      params.maxMan,
      "maxPrice",
      "maxEok",
      "maxMan",
    );

    const minIsRawOnly = minBound.sourceFields.length === 1 && minBound.sourceFields[0] === "minPrice";
    const maxIsRawOnly = maxBound.sourceFields.length === 1 && maxBound.sourceFields[0] === "maxPrice";
    if (minIsRawOnly && maxIsRawOnly) return;

    for (const bound of [minBound, maxBound]) {
      if (bound.value !== undefined && !Number.isSafeInteger(bound.value)) {
        for (const field of bound.sourceFields) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [field],
            message: `${field}이(가) 너무 큽니다`,
          });
        }
        return;
      }
    }

    if (minBound.value === undefined || maxBound.value === undefined) return;
    if (minBound.value <= maxBound.value) return;
    for (const field of [...minBound.sourceFields, ...maxBound.sourceFields]) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [field],
        message: "최소 가격(억/만원 합산 포함)은 최대 가격보다 클 수 없습니다",
      });
    }
  })
  .superRefine((params, ctx) => {
    // 매각기일 범위도 같은 이유(minPrice/maxPrice)로 뒤집힌 조건을 막는다.
    if (params.dateFrom === undefined || params.dateTo === undefined) return;
    if (params.dateFrom <= params.dateTo) return; // YYYY-MM-DD는 사전식 비교가 날짜 순서와 같다
    for (const name of ["dateFrom", "dateTo"] as const) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [name],
        message: "dateFrom은 dateTo보다 늦을 수 없습니다",
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
  if (params.needsAnalysis !== undefined) query.needsAnalysis = params.needsAnalysis;
  if (params.promptVersion !== undefined) query.promptVersion = params.promptVersion;
  if (params.usage !== undefined) query.usageTypes = params.usage;
  // minPrice/maxPrice는 원 단위 파라미터가 있으면 그대로, 없으면 억/만원(eok/man)을
  // 합산한 값을 쓴다(design.md D3, tasks.md 2.2 — 원 단위가 이긴다). ItemQuery는
  // 합산된 원 단위 값만 갖는다 — eok/man은 API 계약(minPrice/maxPrice) 밖의 입력
  // 형태일 뿐, 도메인 조건에는 흔적을 남기지 않는다.
  const minBound = effectivePriceBound(
    params.minPrice,
    params.minEok,
    params.minMan,
    "minPrice",
    "minEok",
    "minMan",
  );
  const maxBound = effectivePriceBound(
    params.maxPrice,
    params.maxEok,
    params.maxMan,
    "maxPrice",
    "maxEok",
    "maxMan",
  );
  if (minBound.value !== undefined) query.minPrice = minBound.value;
  if (maxBound.value !== undefined) query.maxPrice = maxBound.value;
  if (params.minFailed !== undefined) query.minFailedBidCount = params.minFailed;
  if (params.q !== undefined) query.addressKeyword = params.q;
  if (params.sido !== undefined) query.sidoValues = params.sido;
  if (params.sigungu !== undefined) query.sigunguValues = params.sigungu;
  if (params.dateFrom !== undefined) query.auctionDateFrom = params.dateFrom;
  if (params.dateTo !== undefined) query.auctionDateTo = params.dateTo;
  if (params.excludePast !== undefined) query.excludePastAuctions = params.excludePast;
  if (params.bookmarked !== undefined) query.bookmarked = params.bookmarked;
  if (params.court !== undefined) query.court = params.court;
  if (params.minDiscountRate !== undefined) query.minDiscountRate = params.minDiscountRate;
  if (params.hasPhotos !== undefined) query.hasPhotos = params.hasPhotos;
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
    // promptVersion은 여기 넣지 않는다 — needsAnalysis 없이 단독으로는 아무 것도
    // 좁히지 않는다(위 ItemQuery.promptVersion 주석 참조).
    query.needsAnalysis !== undefined ||
    (query.usageTypes !== undefined && query.usageTypes.length > 0) ||
    query.minPrice !== undefined ||
    query.maxPrice !== undefined ||
    query.minFailedBidCount !== undefined ||
    (query.addressKeyword !== undefined && query.addressKeyword !== "") ||
    (query.sidoValues !== undefined && query.sidoValues.length > 0) ||
    (query.sigunguValues !== undefined && query.sigunguValues.length > 0) ||
    query.auctionDateFrom !== undefined ||
    query.auctionDateTo !== undefined ||
    query.excludePastAuctions !== undefined ||
    query.bookmarked !== undefined ||
    query.court !== undefined ||
    query.minDiscountRate !== undefined ||
    query.hasPhotos !== undefined
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
