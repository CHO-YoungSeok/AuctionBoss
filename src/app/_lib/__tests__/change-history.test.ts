/**
 * `change-history.ts`의 순수 헬퍼 테스트.
 *
 * 기준점/실제 변경 구별(design.md D2)과 가격 변화폭 계산의 0/파싱 실패 가드는 이전 주기에
 * JSX에 인라인돼 있다가 버그가 나서야 발견된 지점이라 특히 두텁게 고정한다.
 */
import { describe, expect, it } from "vitest";

import type { ItemChange } from "@/lib/domain";

import {
  RECENT_CHANGE_DAYS,
  formatChangeDisplay,
  formatPriceChange,
  hasRealChange,
  isRealChange,
  isRecentlyChanged,
} from "../change-history";

function change(overrides: Partial<ItemChange>): ItemChange {
  return {
    id: 1,
    itemId: 1,
    field: "minBidPrice",
    oldValue: "640000000",
    newValue: "448000000",
    changedAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("isRealChange", () => {
  it("oldValue가 null이면 기준점이므로 false", () => {
    expect(isRealChange({ oldValue: null })).toBe(false);
  });

  it("oldValue가 값이 있으면 실제 변경이므로 true", () => {
    expect(isRealChange({ oldValue: "100" })).toBe(true);
  });
});

describe("hasRealChange", () => {
  it("빈 배열(레거시 물건, 기준점조차 없음)은 false", () => {
    expect(hasRealChange([])).toBe(false);
  });

  it("기준점 행만 있는 배열(신규 물건, 아직 변동 없음)은 false", () => {
    expect(hasRealChange([{ oldValue: null }, { oldValue: null }])).toBe(false);
  });

  it("실제 변경이 하나라도 섞여 있으면 true", () => {
    expect(hasRealChange([{ oldValue: null }, { oldValue: "100" }])).toBe(true);
  });
});

describe("isRecentlyChanged", () => {
  const now = new Date("2026-09-07T00:00:00.000Z");

  it("lastChangedAt이 없으면(레거시/미변경) false", () => {
    expect(isRecentlyChanged(null, now)).toBe(false);
    expect(isRecentlyChanged(undefined, now)).toBe(false);
  });

  it(`정확히 ${RECENT_CHANGE_DAYS}일 이내면 true`, () => {
    const withinBoundary = new Date(
      now.getTime() - RECENT_CHANGE_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString();
    expect(isRecentlyChanged(withinBoundary, now)).toBe(true);

    const wellWithin = new Date(now.getTime() - 1000).toISOString();
    expect(isRecentlyChanged(wellWithin, now)).toBe(true);
  });

  it(`${RECENT_CHANGE_DAYS}일보다 오래됐으면 false`, () => {
    const tooOld = new Date(
      now.getTime() - (RECENT_CHANGE_DAYS * 24 * 60 * 60 * 1000 + 1000),
    ).toISOString();
    expect(isRecentlyChanged(tooOld, now)).toBe(false);
  });

  it("파싱 불가능한 값이면 false(크래시하지 않는다)", () => {
    expect(isRecentlyChanged("이건 날짜가 아니다", now)).toBe(false);
  });
});

describe("formatPriceChange", () => {
  it("하락: 금액·증감액·증감률을 함께 표시하고 direction은 drop", () => {
    const result = formatPriceChange("640000000", "448000000");
    expect(result).toEqual({
      text: "640,000,000원 → 448,000,000원 (-192,000,000원, -30.0%)",
      direction: "drop",
    });
  });

  it("상승: direction은 rise, 부호는 +", () => {
    const result = formatPriceChange("100000000", "150000000");
    expect(result).toEqual({
      text: "100,000,000원 → 150,000,000원 (+50,000,000원, +50.0%)",
      direction: "rise",
    });
  });

  it("변화 없음(같은 값): direction은 flat, 증감 표시 없음", () => {
    const result = formatPriceChange("100000000", "100000000");
    expect(result).toEqual({
      text: "100,000,000원 → 100,000,000원",
      direction: "flat",
    });
  });

  it("oldValue가 0이면 증감률 계산(0으로 나누기)을 생략하고 금액만 표시한다", () => {
    const result = formatPriceChange("0", "500000");
    expect(result.direction).toBe("rise");
    expect(result.text).toBe("0원 → 500,000원 (+500,000원)");
    expect(result.text).not.toMatch(/Infinity|NaN/);
  });

  it("oldValue가 파싱 불가능하면 NaN/Infinity 없이 direction은 unknown", () => {
    const result = formatPriceChange("모름", "500000");
    expect(result.direction).toBe("unknown");
    expect(result.text).not.toMatch(/Infinity|NaN/);
    expect(result.text).toBe("모름 → 500,000원");
  });

  it("newValue가 파싱 불가능해도 NaN/Infinity 없이 direction은 unknown", () => {
    const result = formatPriceChange("500000", "모름");
    expect(result.direction).toBe("unknown");
    expect(result.text).not.toMatch(/Infinity|NaN/);
  });

  it("oldValue가 null(기준점을 실수로 넘긴 경우)이어도 크래시하지 않는다", () => {
    const result = formatPriceChange(null, "500000");
    expect(result.direction).toBe("unknown");
    expect(result.text).not.toMatch(/Infinity|NaN/);
  });
});

describe("formatChangeDisplay", () => {
  it("minBidPrice는 formatPriceChange 결과를 그대로 쓴다", () => {
    const display = formatChangeDisplay(
      change({ field: "minBidPrice", oldValue: "640000000", newValue: "448000000" }),
    );
    expect(display.label).toBe("최저매각가격");
    expect(display.direction).toBe("drop");
    expect(display.text).toBe("640,000,000원 → 448,000,000원 (-192,000,000원, -30.0%)");
  });

  it("failedBidCount는 '2회 → 3회' 형태이고 direction은 null", () => {
    const display = formatChangeDisplay(
      change({ field: "failedBidCount", oldValue: "2", newValue: "3" }),
    );
    expect(display.label).toBe("유찰횟수");
    expect(display.text).toBe("2회 → 3회");
    expect(display.direction).toBeNull();
  });

  it("auctionDate는 날짜 문자열을 Date로 파싱하지 않고 그대로 표시한다", () => {
    const display = formatChangeDisplay(
      change({ field: "auctionDate", oldValue: "2026-01-15", newValue: "2026-02-20" }),
    );
    expect(display.label).toBe("매각기일");
    expect(display.text).toBe("2026-01-15 → 2026-02-20");
  });

  it("status는 문자열을 그대로 표시한다", () => {
    const display = formatChangeDisplay(
      change({ field: "status", oldValue: "진행", newValue: "변경" }),
    );
    expect(display.label).toBe("진행상태");
    expect(display.text).toBe("진행 → 변경");
  });
});
