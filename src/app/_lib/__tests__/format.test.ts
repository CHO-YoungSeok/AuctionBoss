import { describe, expect, it } from "vitest";

import { EMPTY, formatAuctionTime } from "../format";

describe("formatAuctionTime", () => {
  // 실데이터 389건 전부가 이 형식이다(tasks.md 5.3).
  it("네 자리 숫자(HHMM)를 HH:MM으로 바꾼다", () => {
    expect(formatAuctionTime("1000")).toBe("10:00");
  });

  it("0시대·자정 근처도 그대로 두 자리씩 나눈다", () => {
    expect(formatAuctionTime("0930")).toBe("09:30");
    expect(formatAuctionTime("0000")).toBe("00:00");
  });

  it("값이 없으면 EMPTY", () => {
    expect(formatAuctionTime(null)).toBe(EMPTY);
    expect(formatAuctionTime(undefined)).toBe(EMPTY);
    expect(formatAuctionTime("")).toBe(EMPTY);
    expect(formatAuctionTime("   ")).toBe(EMPTY);
  });

  it("네 자리 숫자가 아니면(형식이 예상과 다르면) 원문을 그대로 보여준다", () => {
    expect(formatAuctionTime("10:00")).toBe("10:00");
    expect(formatAuctionTime("100")).toBe("100");
    expect(formatAuctionTime("오전 10시")).toBe("오전 10시");
  });
});
