/**
 * 최저매각가격 ÷ 면적(면적당 가격) 계산.
 *
 * 원래 `src/app/_lib/item-extensions.ts`(화면 표시)에만 있던 계산이었다. 그런데
 * `workers/lib/derived.ts`(분석 프롬프트, enrich-item-fields 실데이터 검증 후 추가)도
 * 똑같은 "최저매각가격 ÷ 면적" 계산이 필요해지면서, 화면과 분석 워커가 각자 계산을
 * 다시 구현하면 가드 조건이 조용히 갈라질 위험이 생겼다(예: 한쪽만 면적 0을 걸러내는
 * 식으로). 이 계산은 애초에 표현 계층 로직이 아니라 순수 도메인 계산이라 여기
 * (`src/lib/domain`)에 두고 양쪽이 같은 함수 하나를 가져다 쓴다 — 정의가 둘이 아니라
 * 하나여야 드리프트가 구조적으로 불가능해진다.
 *
 * `workers/**`는 `src/app/**`를 import하지 않는다(분석기가 웹 앱과 독립적이어야 한다는
 * 원칙) — 그래서 공유가 필요해진 이 함수는 어느 쪽에도 속하지 않는 `src/lib/domain`이
 * 정직한 자리다.
 */
import type { AuctionItem } from "./types";

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
 * 면적 선택은 `minArea` 우선, 없으면 `maxArea` — "이 물건이 차지할 수 있는 가장 작은
 * 면적" 기준으로 나누는 편이 입찰자에게 더 보수적인(면적당 가격이 더 높게 나오는, 즉
 * 손해를 과소평가하지 않는) 수치를 준다는 판단이다.
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
