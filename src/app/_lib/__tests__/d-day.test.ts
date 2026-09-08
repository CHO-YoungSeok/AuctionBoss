import { describe, expect, it } from "vitest";

import { EMPTY } from "../format";
import { computeDDay, formatDDay } from "../d-day";

// 기준 시각: 2026-09-08 12:00 KST (=2026-09-08T03:00:00Z, UTC+9).
const NOW = new Date("2026-09-08T03:00:00Z");

describe("computeDDay", () => {
  it("오늘이면 status=today, days=0", () => {
    expect(computeDDay("2026-09-08", NOW)).toEqual({ status: "today", days: 0 });
  });

  it("어제면 status=past(지남), days=-1", () => {
    expect(computeDDay("2026-09-07", NOW)).toEqual({ status: "past", days: -1 });
  });

  it("내일이면 status=upcoming, days=1", () => {
    expect(computeDDay("2026-09-09", NOW)).toEqual({ status: "upcoming", days: 1 });
  });

  it("proposal 예시(2026-09-10, D-2)와 같은 케이스", () => {
    expect(computeDDay("2026-09-10", NOW)).toEqual({ status: "upcoming", days: 2 });
  });

  it("값이 없으면 unknown", () => {
    expect(computeDDay(null, NOW)).toEqual({ status: "unknown", days: null });
    expect(computeDDay(undefined, NOW)).toEqual({ status: "unknown", days: null });
  });

  it("형식이 예상과 다르면(YYYY-MM-DD가 아니면) unknown — 짐작해 날짜를 지어내지 않는다", () => {
    expect(computeDDay("2026/09/08", NOW)).toEqual({ status: "unknown", days: null });
    expect(computeDDay("not-a-date", NOW)).toEqual({ status: "unknown", days: null });
    expect(computeDDay("", NOW)).toEqual({ status: "unknown", days: null });
  });

  // KST 자정 경계 — UTC로 파싱하면 하루 밀려 보일 수 있는 경우(format.ts의 관례와 같은
  // 이유). now가 UTC로는 여전히 2026-09-07이지만 KST로는 이미 2026-09-08 00:30이다.
  it("KST 자정을 넘긴 시각도 KST 달력 날짜로 '오늘'을 판정한다", () => {
    const justAfterMidnightKst = new Date("2026-09-07T15:30:00Z"); // 2026-09-08 00:30 KST
    expect(computeDDay("2026-09-08", justAfterMidnightKst)).toEqual({
      status: "today",
      days: 0,
    });
    expect(computeDDay("2026-09-07", justAfterMidnightKst)).toEqual({
      status: "past",
      days: -1,
    });
  });
});

describe("formatDDay", () => {
  it("today → '오늘'", () => {
    expect(formatDDay({ status: "today", days: 0 })).toBe("오늘");
  });

  it("upcoming → 'D-N'", () => {
    expect(formatDDay({ status: "upcoming", days: 2 })).toBe("D-2");
  });

  it("past → '지남'", () => {
    expect(formatDDay({ status: "past", days: -1 })).toBe("지남");
  });

  it("unknown → EMPTY", () => {
    expect(formatDDay({ status: "unknown", days: null })).toBe(EMPTY);
  });
});
