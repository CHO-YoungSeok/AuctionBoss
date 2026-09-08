import { describe, expect, it } from "vitest";

import {
  RATE_MISMATCH_THRESHOLD_PP,
  detectFailedBidRateMismatch,
  formatMismatchDescription,
} from "../bid-mismatch";

describe("detectFailedBidRateMismatch", () => {
  // 실측 사례(design.md D3, tasks.md 3.2) — 유찰 8회인데 가격은 1회 유찰 수준(80%).
  it("failed=8, rate=80 → 모순 (실측 사례)", () => {
    const result = detectFailedBidRateMismatch({
      failedBidCount: 8,
      minBidPriceRateRound1: 80,
    });
    expect(result).not.toBeNull();
    expect(result?.mismatched).toBe(true);
    expect(result?.expectedRatePercent).toBeCloseTo(16.777216, 5);
    expect(result?.diffPercentPoints).toBeGreaterThan(RATE_MISMATCH_THRESHOLD_PP);
  });

  // 실측 사례 — 유찰 16회, 저감률 3% → 0.8^16 ≈ 2.81%로 정합.
  it("failed=16, rate=3 → 정합 (실측 사례)", () => {
    const result = detectFailedBidRateMismatch({
      failedBidCount: 16,
      minBidPriceRateRound1: 3,
    });
    expect(result?.mismatched).toBe(false);
    expect(result?.diffPercentPoints).toBeLessThan(1);
  });

  // 실측 사례 — 유찰 1회인데 저감이 전혀 없다는 100%.
  it("failed=1, rate=100 → 모순 (실측 사례)", () => {
    const result = detectFailedBidRateMismatch({
      failedBidCount: 1,
      minBidPriceRateRound1: 100,
    });
    expect(result?.mismatched).toBe(true);
    expect(result?.expectedRatePercent).toBe(80);
    expect(result?.diffPercentPoints).toBe(20);
  });

  it("유찰 0회 · 저감 없음(100%)이면 정합", () => {
    const result = detectFailedBidRateMismatch({
      failedBidCount: 0,
      minBidPriceRateRound1: 100,
    });
    expect(result?.mismatched).toBe(false);
    expect(result?.diffPercentPoints).toBe(0);
  });

  it("failedBidCount가 null이면 판정 불가(null)", () => {
    expect(
      detectFailedBidRateMismatch({ failedBidCount: null, minBidPriceRateRound1: 80 }),
    ).toBeNull();
  });

  it("minBidPriceRateRound1이 null이면 판정 불가(null)", () => {
    expect(
      detectFailedBidRateMismatch({ failedBidCount: 8, minBidPriceRateRound1: null }),
    ).toBeNull();
  });

  it("둘 다 null이면 판정 불가(null)", () => {
    expect(
      detectFailedBidRateMismatch({ failedBidCount: null, minBidPriceRateRound1: null }),
    ).toBeNull();
  });

  it("failedBidCount가 음수(데이터 이상값)이면 판정 불가", () => {
    expect(
      detectFailedBidRateMismatch({ failedBidCount: -1, minBidPriceRateRound1: 80 }),
    ).toBeNull();
  });

  it("NaN/Infinity가 새지 않는다", () => {
    const result = detectFailedBidRateMismatch({ failedBidCount: 8, minBidPriceRateRound1: 80 });
    expect(result).not.toBeNull();
    if (result !== null) {
      expect(Number.isFinite(result.expectedRatePercent)).toBe(true);
      expect(Number.isFinite(result.diffPercentPoints)).toBe(true);
    }
  });
});

describe("formatMismatchDescription", () => {
  it("어느 쪽이 맞는지 판단하지 않고 두 값을 그대로 보여준다(design.md D3)", () => {
    const result = detectFailedBidRateMismatch({
      failedBidCount: 8,
      minBidPriceRateRound1: 80,
    });
    expect(result).not.toBeNull();
    if (result === null) return;
    const text = formatMismatchDescription(result);
    expect(text).toContain("8회");
    expect(text).toContain("80.0%");
    expect(text).not.toMatch(/NaN|Infinity|undefined/);
  });
});
