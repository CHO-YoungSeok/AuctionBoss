/**
 * 목록 화면의 저감률(최저매각가격 ÷ 감정가) 계산·표시·단계 구분.
 *
 * `computePricePerArea`(`src/lib/domain/price.ts`)의 가드 스타일을 그대로 따른다: 계산이
 * 실패하는 모든 경우(감정가 없음·0·음수, 최저가 없음, 부동소수 오차로 인한 비유한값)를
 * 여기서 전부 끝내서 `NaN`/`Infinity`가 호출자(JSX)로 새 나가지 않게 한다(tasks.md 1.1).
 *
 * 저감률 자체는 이 화면(목록)에만 필요한 표시 계산이라 `computePricePerArea`처럼
 * `src/lib/domain`으로 옮길 이유가 없다 — 분석 워커는 이 비율을 쓰지 않는다
 * (`workers/lib/derived.ts`의 파생 지표는 면적당 가격·차수별 추이뿐이다).
 */
import type { AuctionItem } from "@/lib/domain";

import { EMPTY } from "./format";

/** `AuctionItem`에서 저감률 계산에 쓰는 부분집합. */
export type DiscountRatioFields = Pick<AuctionItem, "appraisalPrice" | "minBidPrice">;

/**
 * 최저매각가격 ÷ 감정가를 계산한다. 실패하는 모든 경우를 가드한다:
 * - 감정가가 없거나(null) 숫자가 아니거나 0 이하이면(0으로 나누기 방지) 계산하지 않는다.
 * - 최저매각가격이 없거나 숫자가 아니면 계산하지 않는다.
 * - 비율이 1을 넘는 경우(데이터 이상값, 이론상 발생하지 않아야 하지만 방어적으로 허용)도
 *   `Number.isFinite`만 통과하면 그대로 반환한다 — 상한을 임의로 자르면 실제 값과 다른
 *   숫자를 보여주게 된다. 대신 `classifyDiscountStage`가 1 이상을 "appraisal" 단계로
 *   묶어 화면이 깨지지 않게 한다.
 * - 결과가 `Number.isFinite`가 아니면 null.
 */
export function computeDiscountRatio({
  appraisalPrice,
  minBidPrice,
}: DiscountRatioFields): number | null {
  if (typeof appraisalPrice !== "number" || !Number.isFinite(appraisalPrice) || appraisalPrice <= 0) {
    return null;
  }
  if (typeof minBidPrice !== "number" || !Number.isFinite(minBidPrice)) return null;

  const ratio = minBidPrice / appraisalPrice;
  return Number.isFinite(ratio) ? ratio : null;
}

/** 저감률을 `"80.0%"` 형태로 표시한다. 소수 첫째 자리까지. */
export function formatDiscountRatio(ratio: number | null): string {
  if (ratio === null) return EMPTY;
  return `${(ratio * 100).toFixed(1)}%`;
}

/**
 * 저감률 단계 (design.md D1, ux-overhaul-phase1 task 6.1로 재조정).
 *
 * 국내 법원경매는 통상 유찰 1회당 감정가의 80%로 재산정한다(20% 저감) — 실데이터
 * 389건의 저감률(소수 2자리 반올림) 분포가 정확히 이것을 뒷받침한다:
 * 1.0=164건, 0.8=102건, 0.64=66건, 0.51(0.8³=0.512)=20건, 0.41(0.8⁴=0.4096)=20건,
 * 그 아래(0.8⁵ 이하, 유찰 5회 이상 추정)가 나머지 17건. 이전 버전은 4단계뿐이라
 * 0.03~0.63의 57건(0.51대+0.41대+나머지)이 "64% 미만" 한 칸에 뭉쳐 있었다 — 이번에
 * 그 분포를 그대로 반영해 6단계로 늘린다.
 *
 * 이 유니온에 새 단계를 추가하면 `DISCOUNT_STAGE_LABELS`(Record)가 컴파일 오류로 걸린다
 * — 라벨 없는 단계가 조용히 화면에서 빠지는(렌더링되지 않는) 사고를 막는다(tasks.md 1.2,
 * 6.2).
 */
export type DiscountStage =
  | "appraisal"
  | "firstDrop"
  | "secondDrop"
  | "thirdDrop"
  | "fourthDrop"
  | "deepDrop";

/**
 * 단계별 표시 라벨. **색에만 의존하지 않는다** — 이 텍스트 자체가 단계를 구별하는
 * 주된 수단이고, 페이지의 CSS 클래스(`discount-stage-*`)는 훑어보기 쉽게 돕는
 * 보조 수단일 뿐이다(design.md D1 Risk, spec: "색에만 의존해서는 안 된다").
 */
export const DISCOUNT_STAGE_LABELS: Record<DiscountStage, string> = {
  appraisal: "100%대",
  firstDrop: "80%대",
  secondDrop: "64%대",
  thirdDrop: "51%대",
  fourthDrop: "41%대",
  deepDrop: "41% 미만",
};

/**
 * 이론 경계값(0.8ⁿ)에서 뺄 허용 오차(task 6.3, 경계 테스트로 고정). 실측 389건을
 * 직접 대조한 결과, 저감률이 이론값(0.8ⁿ)보다 최대 약 6×10⁻⁶ 낮게 관측되는 사례가
 * 있다 — 원 단위로 반올림된 실제 낙찰 최저가를 감정가로 나누는 과정에서 생기는
 * 뜻대로 되지 않는 소수 오차다(예: 실측 id 3의 0.639999531426452, id 5의
 * 0.7999997995643531 — 둘 다 이론값보다 아주 조금 낮다). 이론값을 경계로 그대로 쓰면
 * 이런 실측값이 한 단계 아래로 밀려난다. 0.001(0.1%p)은 이 노이즈(최대 6×10⁻⁶)를
 * 충분히 흡수하면서도 다음 단계 관측 최댓값(예: 4단계 아래 0.8⁵=0.32768 근방)과는
 * 겹치지 않는 값이다 — 이 경계로 실측 389건을 분류하면 위에 적은 분포
 * (164/102/66/20/20/17)가 정확히 재현된다.
 */
const STAGE_TOLERANCE = 0.001;

/**
 * 비율(0~1, 또는 데이터 이상값으로 1 초과)을 단계로 분류한다. `ratio`가 null이면
 * (계산 불가) null — 호출자가 "-"로 표시할 신호다.
 *
 * 1 이상은 전부 "appraisal"로 묶는다 — 정상적인 경매라면 최저가가 감정가를 넘지 않지만,
 * 데이터 이상값이 들어와도 알 수 없는 단계로 튀지 않고 "저감 없음" 쪽 극단에 붙인다.
 */
export function classifyDiscountStage(ratio: number | null): DiscountStage | null {
  if (ratio === null) return null;
  if (ratio >= 1 - STAGE_TOLERANCE) return "appraisal";
  if (ratio >= 0.8 - STAGE_TOLERANCE) return "firstDrop";
  if (ratio >= 0.64 - STAGE_TOLERANCE) return "secondDrop";
  if (ratio >= 0.512 - STAGE_TOLERANCE) return "thirdDrop";
  if (ratio >= 0.4096 - STAGE_TOLERANCE) return "fourthDrop";
  return "deepDrop";
}
