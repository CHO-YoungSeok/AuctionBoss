import { describe, expect, it } from "vitest";

import { EMPTY, formatAuctionTime, formatWonAsEokMan } from "../format";

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

describe("formatWonAsEokMan", () => {
  it("억·만원 단위로 나눠 표시한다", () => {
    expect(formatWonAsEokMan(1_250_000_000)).toBe("12억 5,000만원");
    expect(formatWonAsEokMan(100_000_000)).toBe("1억");
    expect(formatWonAsEokMan(50_000_000)).toBe("5,000만원");
  });

  it("실데이터 범위 경계값(76만원 ~ 261억)도 다룬다", () => {
    expect(formatWonAsEokMan(760_000)).toBe("76만원");
    expect(formatWonAsEokMan(26_100_000_000)).toBe("261억");
  });

  it("만원 단위로 나눠떨어지지 않는 잔액은 원 단위로 덧붙인다(값을 버리지 않는다)", () => {
    expect(formatWonAsEokMan(100_005_000)).toBe("1억 5,000원");
    expect(formatWonAsEokMan(1_234)).toBe("1,234원");
  });

  it("0은 0원으로 표시한다", () => {
    expect(formatWonAsEokMan(0)).toBe("0원");
  });

  it("값이 없으면 EMPTY", () => {
    expect(formatWonAsEokMan(null)).toBe(EMPTY);
    expect(formatWonAsEokMan(undefined)).toBe(EMPTY);
  });
});
