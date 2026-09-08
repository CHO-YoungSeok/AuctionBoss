/**
 * 유찰횟수(`failedBidCount`)와 소스가 준 1차 저감률(`minBidPriceRateRound1`)의 모순을
 * 판정하는 순수 헬퍼 (ux-overhaul-phase1 design.md D3, tasks.md 3.1).
 *
 * 실데이터 389건 중 79건(20%)에서 두 값이 서로 맞지 않는다(예: `failedBidCount=8`인데
 * `minBidPriceRateRound1=80` — 80%는 유찰 1회 수준이지 8회 수준이 아니다). 어느 쪽이
 * 맞는지는 우리가 모른다 — design.md D3: "고치지 않고 드러낸다."
 *
 * 판정 근거: 국내 법원경매는 통상 유찰 1회당 감정가의 80%로 재산정한다(20% 저감,
 * discount.ts의 저감률 단계 재조정이 실측 389건으로 이 규칙을 확인했다 — 1.0/0.8/0.64/
 * 0.51/0.41이 정확히 0.8ⁿ이다). 이 규칙대로라면 `failedBidCount`회 유찰한 물건의 저감률은
 * 이론상 `100 × 0.8^failedBidCount`(%)여야 한다. 실제 저감률이 이 값과 큰 차이가 나면
 * 두 필드 중 하나(또는 둘 다)가 신뢰할 수 없다는 뜻이다.
 */
import type { AuctionItem } from "@/lib/domain";

/**
 * 모순 판정 임계값(퍼센트포인트). 실측 사례 3건으로 정했다:
 * - `failed=8, rate=80` → 예측 16.8%, 실제 80%, 차이 63.2%p → **명백한 모순**
 * - `failed=1, rate=100` → 예측 80.0%, 실제 100%, 차이 20.0%p → **명백한 모순**
 * - `failed=16, rate=3` → 예측 2.8%, 실제 3%, 차이 0.2%p → **정합**
 *
 * 정합 사례(0.2%p)와 모순 사례(20.0%p 이상) 사이 어디든 경계로 쓸 수 있는데, design.md
 * Open Questions("명백한 경우만 잡아도 충분할 수 있다")를 따라 넉넉한 15%p를 쓴다 — 두
 * 값이 조금 어긋나는(반올림·회차 경계 등) 정상적인 경우까지 모순으로 잘못 잡지 않기
 * 위함이다.
 */
export const RATE_MISMATCH_THRESHOLD_PP = 15;

export type FailedBidRateMismatchFields = Pick<
  AuctionItem,
  "failedBidCount" | "minBidPriceRateRound1"
>;

export interface RateMismatchResult {
  /** 두 값이 임계값을 넘겨 어긋나는지. */
  mismatched: boolean;
  failedBidCount: number;
  /** 소스가 준 실제 1차 저감률(%). */
  actualRatePercent: number;
  /** `failedBidCount`회 유찰 규칙(0.8ⁿ)으로 예측한 저감률(%). */
  expectedRatePercent: number;
  /** 두 값의 차이(퍼센트포인트, 항상 0 이상). */
  diffPercentPoints: number;
}

/**
 * 두 값을 대조해 모순 여부를 판정한다. 어느 한쪽이라도 없거나 숫자가 아니면(판정 불가)
 * null — "정합"과 "판정 불가"를 절대 같은 값으로 섞지 않는다(호출자가 배지를 안 그릴
 * 신호는 같지만, 의미는 다르다).
 */
export function detectFailedBidRateMismatch({
  failedBidCount,
  minBidPriceRateRound1,
}: FailedBidRateMismatchFields): RateMismatchResult | null {
  if (
    typeof failedBidCount !== "number" ||
    !Number.isFinite(failedBidCount) ||
    failedBidCount < 0
  ) {
    return null;
  }
  if (
    typeof minBidPriceRateRound1 !== "number" ||
    !Number.isFinite(minBidPriceRateRound1)
  ) {
    return null;
  }

  const expectedRatePercent = 100 * Math.pow(0.8, failedBidCount);
  const diffPercentPoints = Math.abs(minBidPriceRateRound1 - expectedRatePercent);

  return {
    mismatched: diffPercentPoints > RATE_MISMATCH_THRESHOLD_PP,
    failedBidCount,
    actualRatePercent: minBidPriceRateRound1,
    expectedRatePercent,
    diffPercentPoints,
  };
}

/** 배지 옆에 붙일 짧은 설명. design.md D3: 어느 쪽이 맞는지 우리가 판단하지 않고,
 * 두 값과 그 차이를 그대로 보여준다. */
export function formatMismatchDescription(result: RateMismatchResult): string {
  return `유찰 ${result.failedBidCount}회면 저감률이 약 ${result.expectedRatePercent.toFixed(1)}%일 것으로 예상되지만, 실제 저감률은 ${result.actualRatePercent.toFixed(1)}%입니다 — 두 값이 서로 모순되어 어느 쪽이 맞는지 알 수 없습니다.`;
}
