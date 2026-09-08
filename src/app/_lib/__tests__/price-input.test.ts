import { describe, expect, it } from "vitest";

import { PRICE_PRESETS, wonToEokManParts } from "../price-input";

describe("wonToEokManParts", () => {
  it("원 단위 값을 억/만원으로 쪼갠다", () => {
    expect(wonToEokManParts(1_250_000_000)).toEqual({ eok: 12, man: 5000 });
    expect(wonToEokManParts(100_000_000)).toEqual({ eok: 1, man: 0 });
    expect(wonToEokManParts(50_000_000)).toEqual({ eok: 0, man: 5000 });
  });

  it("만원 미만 잔액은 버린다(입력칸은 정수 두 칸뿐이다)", () => {
    expect(wonToEokManParts(100_005_000)).toEqual({ eok: 1, man: 0 });
  });

  it("값이 없거나 0 이하이면 0/0이다", () => {
    expect(wonToEokManParts(undefined)).toEqual({ eok: 0, man: 0 });
    expect(wonToEokManParts(0)).toEqual({ eok: 0, man: 0 });
    expect(wonToEokManParts(-100)).toEqual({ eok: 0, man: 0 });
  });
});

describe("PRICE_PRESETS", () => {
  it("다섯 개 프리셋이 minPrice/maxPrice 키를 항상 둘 다 갖는다(override 병합용)", () => {
    expect(PRICE_PRESETS).toHaveLength(5);
    for (const preset of PRICE_PRESETS) {
      expect(preset).toHaveProperty("minPrice");
      expect(preset).toHaveProperty("maxPrice");
    }
  });

  it("경계가 겹치지 않고 이어진다", () => {
    expect(PRICE_PRESETS.map((p) => p.label)).toEqual(["1억 이하", "1~3억", "3~5억", "5~10억", "10억+"]);
    expect(PRICE_PRESETS[0]!.maxPrice).toBe(PRICE_PRESETS[1]!.minPrice);
  });
});
