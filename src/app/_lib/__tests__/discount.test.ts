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

  it("0.8 이상이면 firstDrop(80%대) — 경계값 포함", () => {
    expect(classifyDiscountStage(0.8)).toBe("firstDrop");
    expect(classifyDiscountStage(0.99)).toBe("firstDrop");
  });

  it("0.64 이상이면 secondDrop(64%대) — 경계값 포함", () => {
    expect(classifyDiscountStage(0.64)).toBe("secondDrop");
    expect(classifyDiscountStage(0.79)).toBe("secondDrop");
  });

  // 재조정(task 6.1) — 실측 분포 0.51=20건이 이전에는 "64% 미만" 한 칸에 뭉쳐 있었다.
  it("0.512(0.8³) 이상이면 thirdDrop(51%대) — 경계값 포함", () => {
    expect(classifyDiscountStage(0.512)).toBe("thirdDrop");
    expect(classifyDiscountStage(0.6)).toBe("thirdDrop");
  });

  it("0.4096(0.8⁴) 이상이면 fourthDrop(41%대) — 경계값 포함", () => {
    expect(classifyDiscountStage(0.4096)).toBe("fourthDrop");
    expect(classifyDiscountStage(0.5)).toBe("fourthDrop");
  });

  it("그 아래는 deepDrop(41% 미만) — 실측 최댓값(0.327681, 0.8⁵ 근방)도 여기 속한다", () => {
    expect(classifyDiscountStage(0.327681)).toBe("deepDrop");
    expect(classifyDiscountStage(0.03)).toBe("deepDrop");
    expect(classifyDiscountStage(0)).toBe("deepDrop");
  });

  // 실측 노이즈(discount.ts STAGE_TOLERANCE 주석 참고) — 이론값보다 미세하게(최대
  // 6×10⁻⁶) 낮은 실측값도 같은 단계로 분류돼야 한다. 실제 관측값을 그대로 쓴다.
  it("실측 노이즈가 있는 경계값도 올바른 단계로 분류된다(id 5, id 3 패턴)", () => {
    expect(classifyDiscountStage(0.7999997995643531)).toBe("firstDrop"); // 실측 id 5
    expect(classifyDiscountStage(0.639999531426452)).toBe("secondDrop"); // 실측 id 3
  });

  it("모든 단계에 텍스트 라벨이 있다 — 색에만 의존하지 않는다", () => {
    const stages: DiscountStage[] = [
      "appraisal",
      "firstDrop",
      "secondDrop",
      "thirdDrop",
      "fourthDrop",
      "deepDrop",
    ];
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
