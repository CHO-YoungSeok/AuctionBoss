import { describe, expect, it } from "vitest";

import { EMPTY } from "../format";
import {
  DISCOUNT_STAGE_LABELS,
  classifyDiscountStage,
  computeDiscountRatio,
  formatDiscountRatio,
  type DiscountStage,
} from "../discount";

describe("computeDiscountRatio", () => {
  it("정상 값이면 최저매각가격 ÷ 감정가", () => {
    expect(computeDiscountRatio({ appraisalPrice: 1_000_000_000, minBidPrice: 800_000_000 })).toBe(
      0.8,
    );
  });

  it("감정가가 null이면 계산하지 않는다", () => {
    expect(computeDiscountRatio({ appraisalPrice: null, minBidPrice: 800_000_000 })).toBeNull();
  });

  it("감정가가 0이면 계산하지 않는다(0으로 나누기 방지)", () => {
    expect(computeDiscountRatio({ appraisalPrice: 0, minBidPrice: 800_000_000 })).toBeNull();
  });

  it("감정가가 음수여도(데이터 이상값) 계산하지 않는다", () => {
    expect(computeDiscountRatio({ appraisalPrice: -1, minBidPrice: 800_000_000 })).toBeNull();
  });

  it("최저매각가격이 null이면 계산하지 않는다", () => {
    expect(computeDiscountRatio({ appraisalPrice: 1_000_000_000, minBidPrice: null })).toBeNull();
  });

  it("최저매각가격이 0이면 0을 반환한다(값 없음이 아니라 실제 0)", () => {
    expect(computeDiscountRatio({ appraisalPrice: 1_000_000_000, minBidPrice: 0 })).toBe(0);
  });

  it("비율이 1을 넘어도(데이터 이상값) 그대로 유한값을 반환한다", () => {
    expect(computeDiscountRatio({ appraisalPrice: 1_000_000_000, minBidPrice: 1_200_000_000 })).toBe(
      1.2,
    );
  });

  it("NaN/Infinity가 새지 않는다 — 결과가 항상 null 또는 유한수", () => {
    const result = computeDiscountRatio({ appraisalPrice: 1_000_000_000, minBidPrice: 800_000_000 });
    expect(result === null || Number.isFinite(result)).toBe(true);
  });
});

describe("formatDiscountRatio", () => {
  it("null이면 EMPTY", () => {
    expect(formatDiscountRatio(null)).toBe(EMPTY);
  });

  it("소수 첫째 자리까지 퍼센트로 표시한다", () => {
    expect(formatDiscountRatio(0.8)).toBe("80.0%");
    expect(formatDiscountRatio(0.6432)).toBe("64.3%");
  });

  it("NaN/Infinity 문자열이 나오지 않는다", () => {
    expect(formatDiscountRatio(0.8)).not.toMatch(/NaN|Infinity|undefined/);
  });
});

describe("classifyDiscountStage", () => {
  it("null이면 null(계산 불가)", () => {
    expect(classifyDiscountStage(null)).toBeNull();
  });

  it("1 이상이면 appraisal(100%대) — 경계값 포함", () => {
    expect(classifyDiscountStage(1)).toBe("appraisal");
    expect(classifyDiscountStage(1.2)).toBe("appraisal");
  });

  it("0.8 이상 1 미만이면 firstDrop(80%대) — 경계값 포함", () => {
    expect(classifyDiscountStage(0.8)).toBe("firstDrop");
    expect(classifyDiscountStage(0.99)).toBe("firstDrop");
  });

  it("0.64 이상 0.8 미만이면 secondDrop(64%대) — 경계값 포함", () => {
    expect(classifyDiscountStage(0.64)).toBe("secondDrop");
    expect(classifyDiscountStage(0.79)).toBe("secondDrop");
  });

  it("0.64 미만이면 deepDrop(64% 미만)", () => {
    expect(classifyDiscountStage(0.639)).toBe("deepDrop");
    expect(classifyDiscountStage(0)).toBe("deepDrop");
  });

  it("모든 단계에 텍스트 라벨이 있다 — 색에만 의존하지 않는다", () => {
    const stages: DiscountStage[] = ["appraisal", "firstDrop", "secondDrop", "deepDrop"];
    for (const stage of stages) {
      expect(DISCOUNT_STAGE_LABELS[stage]).toEqual(expect.any(String));
      expect(DISCOUNT_STAGE_LABELS[stage].length).toBeGreaterThan(0);
    }
  });

  it("라벨은 전부 서로 다른 문자열이다 — 텍스트만으로 단계가 구별된다", () => {
    const labels = Object.values(DISCOUNT_STAGE_LABELS);
    expect(new Set(labels).size).toBe(labels.length);
  });
});
