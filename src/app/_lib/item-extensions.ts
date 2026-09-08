/**
 * 물건 상세 화면이 확장 필드(enrich-item-fields, `AuctionItem`의 32개 nullable 필드)를
 * 표시하기 위해 쓰는 순수 헬퍼.
 *
 * change-history.ts/analysis-history.ts의 선례를 따라 표시 판정을 JSX 밖으로 뽑아 테스트로
 * 고정한다 — "이 프로젝트는 표시 판정이 JSX에 인라인돼 있다가 버그로 발견된 적이 있다"는
 * 경고(tasks.md task 4.4)가 이 파일의 존재 이유다.
 *
 * design.md D3(값 없음과 0 구분)·D4(의미를 모르는 코드값을 해석하지 않음)를 그대로 따른다:
 * - 가격·면적·차수별 값은 데이터 계층에서 이미 0을 null로 접어 뒀으므로, 여기서는 "값이
 *   있으면 표시하고 없으면 EMPTY"만 하면 된다. 0-vs-없음 재판정을 이 파일에서 하지 않는다.
 * - 코드값(용도 대/중/소분류, 진행상태/물건상태 코드, 좌표)은 절대 해석하지 않는다. 이
 *   파일은 그 필드들에 라벨을 붙이는 함수를 두지 않는다 — 붙일 라벨이 없다는 뜻이다.
 */
import type { AuctionItem } from "@/lib/domain";

import { EMPTY, formatWon } from "./format";

const integerFormatter = new Intl.NumberFormat("ko-KR");

// ---------------------------------------------------------------------------
// 면적 · 건물 구조
// ---------------------------------------------------------------------------

/** `AuctionItem`에서 면적 표시에 쓰는 부분집합. */
export type AreaFields = Pick<AuctionItem, "minArea" | "maxArea">;

/**
 * 면적을 사람이 읽는 문자열로 만든다. `minArea`/`maxArea`가 같으면(REAL_ROW의 실제 관측
 * 값이 그렇듯 대부분 같다) 한 번만 보여주고, 다르면 범위로 보여준다. 둘 다 없으면 EMPTY.
 */
export function formatAreaRange({ minArea, maxArea }: AreaFields): string {
  const min = typeof minArea === "number" && Number.isFinite(minArea) ? minArea : null;
  const max = typeof maxArea === "number" && Number.isFinite(maxArea) ? maxArea : null;
  if (min === null && max === null) return EMPTY;
  if (min !== null && max !== null) {
    return min === max ? `${min}㎡` : `${min}㎡ ~ ${max}㎡`;
  }
  return `${(min ?? max)!}㎡`;
}

// ---------------------------------------------------------------------------
// 면적당 가격 (task 4.4)
//
// 판단 근거: `minArea`/`maxArea`는 REAL_ROW를 포함한 관측값에서 대부분 같은 값이지만,
// 다를 때는 "이 물건이 차지할 수 있는 가장 작은 면적" 기준으로 나누는 편이 입찰자에게
// 더 보수적인(면적당 가격이 더 높게 나오는, 즉 손해를 과소평가하지 않는) 수치를 준다는
// 판단으로 `minArea`를 우선한다. `minArea`가 없으면 `maxArea`로 대체한다. 이 선택은
// design.md의 "면적당 가격을 정렬 기준으로 쓸지는 나중에 판단" open question과 무관하게
// 화면 표시 하나만을 위한 결정이다.
// ---------------------------------------------------------------------------

/** `AuctionItem`에서 면적당 가격 계산에 쓰는 부분집합. */
export type PricePerAreaFields = Pick<AuctionItem, "minBidPrice" | "minArea" | "maxArea">;

/**
 * 최저매각가격 ÷ 면적(원/㎡)을 계산한다. 실패하는 모든 경우를 가드해서 `NaN`/`Infinity`가
 * 호출자에게 새 나가지 않게 한다:
 * - `minBidPrice`가 없거나(null) 숫자가 아니면 계산하지 않는다.
 * - 면적이 둘 다 없으면 계산하지 않는다.
 * - 면적이 0 이하이면(이론상 데이터 계층이 0을 이미 null로 접어 두지만, 방어적으로 다시
 *   확인한다) 0으로 나누기가 되므로 계산하지 않는다.
 * - 결과가 `Number.isFinite`가 아니면(부동소수 오차로 Infinity가 나오는 극단값 등) null.
 *
 * 면적 선택은 위 판단 근거대로 `minArea` 우선, 없으면 `maxArea`.
 */
export function computePricePerArea({
  minBidPrice,
  minArea,
  maxArea,
}: PricePerAreaFields): number | null {
  if (typeof minBidPrice !== "number" || !Number.isFinite(minBidPrice)) return null;

  const area =
    typeof minArea === "number" && Number.isFinite(minArea) && minArea > 0
      ? minArea
      : typeof maxArea === "number" && Number.isFinite(maxArea) && maxArea > 0
        ? maxArea
        : null;
  if (area === null) return null;

  const result = minBidPrice / area;
  return Number.isFinite(result) ? result : null;
}

/** `computePricePerArea`의 결과를 화면 문자열로 만든다. 원 단위 반올림 후 천 단위 구분. */
export function formatPricePerArea(value: number | null): string {
  if (value === null) return EMPTY;
  return `${integerFormatter.format(Math.round(value))}원/㎡`;
}

// ---------------------------------------------------------------------------
// 차수별 최저매각가격
// ---------------------------------------------------------------------------

export interface RoundPrice {
  round: 1 | 2 | 3 | 4;
  /** 원. 항상 유한한 값(0은 데이터 계층이 이미 null로 접었다 — design.md D3). */
  price: number;
  /** %. 1·2차만 소스가 준다(NOTES.md §11) — 3·4차는 항상 null. */
  ratePercent: number | null;
}

/** `AuctionItem`에서 차수별 최저가 표시에 쓰는 부분집합. */
export type RoundPriceFields = Pick<
  AuctionItem,
  | "minBidPriceRound1"
  | "minBidPriceRound2"
  | "minBidPriceRound3"
  | "minBidPriceRound4"
  | "minBidPriceRateRound1"
  | "minBidPriceRateRound2"
>;

/**
 * 값이 있는 회차만 골라 순서대로 돌려준다 — 값이 없는 회차는 빈 행을 만들지 않고 그냥
 * 건너뛴다(task 4.4: "값이 없는 회차는 빈 행을 만들지 않고 건너뛰는 렌더러").
 */
export function listRoundPrices(item: RoundPriceFields): RoundPrice[] {
  const defs: Array<{ round: 1 | 2 | 3 | 4; price: number | null | undefined; rate: number | null | undefined }> = [
    { round: 1, price: item.minBidPriceRound1, rate: item.minBidPriceRateRound1 },
    { round: 2, price: item.minBidPriceRound2, rate: item.minBidPriceRateRound2 },
    { round: 3, price: item.minBidPriceRound3, rate: null },
    { round: 4, price: item.minBidPriceRound4, rate: null },
  ];
  const rounds: RoundPrice[] = [];
  for (const def of defs) {
    if (typeof def.price !== "number" || !Number.isFinite(def.price)) continue;
    const rate =
      typeof def.rate === "number" && Number.isFinite(def.rate) ? def.rate : null;
    rounds.push({ round: def.round, price: def.price, ratePercent: rate });
  }
  return rounds;
}

/** 차수별 최저가 한 행을 `"1차: 711,000,000원 (100%)"` 형태로 만든다. `ratePercent`가
 * 없으면 괄호를 생략한다. */
export function formatRoundPrice(round: RoundPrice): string {
  const price = formatWon(round.price);
  return round.ratePercent === null
    ? `${round.round}차: ${price}`
    : `${round.round}차: ${price} (${round.ratePercent}%)`;
}

// ---------------------------------------------------------------------------
// 용도 분류 (design.md D4 — 코드표 미확인, 원문 보존)
// ---------------------------------------------------------------------------

/** `AuctionItem`에서 용도 코드 표시에 쓰는 부분집합. */
export type UsageCodeFields = Pick<
  AuctionItem,
  "usageCodeLarge" | "usageCodeMedium" | "usageCodeSmall"
>;

/**
 * 용도 대/중/소분류 코드를 있는 값만 이어붙여 보여준다. **절대 라벨을 붙이지 않는다** —
 * 코드표가 확인되지 않았으므로(design.md D4) 무슨 뜻인지 안다는 듯 보이는 텍스트를 만들면
 * 안 된다. 호출부(JSX)가 이 값을 "원본 코드"라는 라벨과 함께 보여줘야 한다.
 */
export function formatUsageCodes({ usageCodeLarge, usageCodeMedium, usageCodeSmall }: UsageCodeFields): string {
  const parts = [usageCodeLarge, usageCodeMedium, usageCodeSmall].filter(
    (value): value is string => typeof value === "string" && value.trim() !== "",
  );
  return parts.length > 0 ? parts.join(" / ") : EMPTY;
}

// ---------------------------------------------------------------------------
// 구조화된 소재지
// ---------------------------------------------------------------------------

/** `AuctionItem`에서 구조화된 소재지 표시에 쓰는 부분집합. */
export type StructuredAddressFields = Pick<
  AuctionItem,
  "sido" | "sigungu" | "dong" | "lotNumber" | "buildingName" | "buildingUnit"
>;

/**
 * 소재지 구조화 값(시/도·시/군/구·동·대표지번·건물명·동/층/호)을 값이 있는 것만 순서대로
 * 이어붙인다. `address`(조합 문자열, 기존 필드)와 별개의 표시다 — 소스가 이미 조각내 준
 * 값을 그대로 보여준다.
 */
export function formatStructuredAddress({
  sido,
  sigungu,
  dong,
  lotNumber,
  buildingName,
  buildingUnit,
}: StructuredAddressFields): string {
  const parts = [sido, sigungu, dong, lotNumber, buildingName, buildingUnit].filter(
    (value): value is string => typeof value === "string" && value.trim() !== "",
  );
  return parts.length > 0 ? parts.join(" ") : EMPTY;
}
