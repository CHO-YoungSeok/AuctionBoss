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
 * 저감률 단계 (design.md D1 — "예: 100% / 80%대 / 64%대 / 그 이하").
 *
 * 경계값은 실측 데이터 분포가 아니라 국내 법원경매의 통상적인 저감 단위(1회 유찰 시
 * 감정가의 80%, 2회 유찰 시 64%)를 참고해 정한 상수다(design.md Open Questions: "실제
 * 데이터 분포를 보고 정한다. 상수라 바꾸기 쉽다" — 아직 실데이터 분포 검증 전이므로
 * 이 값을 바꾸기 쉽게 상수/타입으로 분리해 둔다).
 *
 * 이 유니온에 새 단계를 추가하면 `DISCOUNT_STAGE_LABELS`(Record)가 컴파일 오류로 걸린다
 * — 라벨 없는 단계가 조용히 화면에서 빠지는(렌더링되지 않는) 사고를 막는다(tasks.md 1.2).
 */
export type DiscountStage = "appraisal" | "firstDrop" | "secondDrop" | "deepDrop";

/**
 * 단계별 표시 라벨. **색에만 의존하지 않는다** — 이 텍스트 자체가 단계를 구별하는
 * 주된 수단이고, 페이지의 CSS 클래스(`discount-stage-*`)는 훑어보기 쉽게 돕는
 * 보조 수단일 뿐이다(design.md D1 Risk, spec: "색에만 의존해서는 안 된다").
 */
export const DISCOUNT_STAGE_LABELS: Record<DiscountStage, string> = {
  appraisal: "100%대",
  firstDrop: "80%대",
  secondDrop: "64%대",
  deepDrop: "64% 미만",
};

/**
 * 비율(0~1, 또는 데이터 이상값으로 1 초과)을 단계로 분류한다. `ratio`가 null이면
 * (계산 불가) null — 호출자가 "-"로 표시할 신호다.
 *
 * 1 이상은 전부 "appraisal"로 묶는다 — 정상적인 경매라면 최저가가 감정가를 넘지 않지만,
 * 데이터 이상값이 들어와도 알 수 없는 단계로 튀지 않고 "저감 없음" 쪽 극단에 붙인다.
 */
export function classifyDiscountStage(ratio: number | null): DiscountStage | null {
  if (ratio === null) return null;
  if (ratio >= 1) return "appraisal";
  if (ratio >= 0.8) return "firstDrop";
  if (ratio >= 0.64) return "secondDrop";
  return "deepDrop";
}
