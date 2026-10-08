import { describe, expect, it } from "vitest";

import { withFixedNow } from "../fixed-clock";

describe("withFixedNow", () => {
  const NOW = "2026-10-08T00:00:03.000Z";

  it("인자 없는 new Date()와 Date.now()가 고정 시각이다", async () => {
    await withFixedNow(NOW, async () => {
      const a = new Date();
      await new Promise((r) => setTimeout(r, 5)); // 타이머는 정상 동작한다
      const b = new Date();
      expect(a.toISOString()).toBe(NOW);
      expect(b.toISOString()).toBe(NOW);
      expect(Date.now()).toBe(Date.parse(NOW));
    });
  });

  it("인자가 있는 생성과 Date.parse/UTC는 원래대로다", async () => {
    await withFixedNow(NOW, () => {
      expect(new Date("2020-01-02T03:04:05.006Z").toISOString()).toBe("2020-01-02T03:04:05.006Z");
      expect(new Date(0).toISOString()).toBe("1970-01-01T00:00:00.000Z");
      expect(new Date(2020, 0, 1) instanceof Date).toBe(true);
      expect(Date.parse("2020-01-01T00:00:00Z")).toBe(1577836800000);
      expect(Date.UTC(2020, 0, 1)).toBe(1577836800000);
    });
  });

  it("끝나면(예외여도) 전역 Date를 되돌린다", async () => {
    const real = Date;
    await expect(
      withFixedNow(NOW, () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(Date).toBe(real);
    expect(new Date().toISOString()).not.toBe(NOW);
  });

  it("올바르지 않은 시각은 거절한다", async () => {
    await expect(withFixedNow("nope", () => 1)).rejects.toThrow();
  });
});
