import { describe, expect, it } from "vitest";

import type { CourtRef } from "../types";
import { computeLapDurationMs, selectRotationCourts } from "../rotation";

const courts3: CourtRef[] = [
  { name: "서울중앙지방법원", courtCode: "B000210" },
  { name: "서울동부지방법원", courtCode: "B000211" },
  { name: "서울서부지방법원", courtCode: "B000215" },
];

const singleCourt: CourtRef[] = [{ name: "서울중앙지방법원", courtCode: "B000210" }];

describe("selectRotationCourts", () => {
  it("법원 3곳 × 상한 1곳 — 회차마다 하나씩, 3회차면 전부 한 번씩 순환한다(2.3)", () => {
    let start: string | null = null;
    const visited: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const { selectedCourts, nextStartCourtCode } = selectRotationCourts(courts3, start, 1);
      expect(selectedCourts).toHaveLength(1);
      visited.push(selectedCourts[0]!.courtCode);
      start = nextStartCourtCode;
    }
    expect(visited).toEqual(["B000210", "B000211", "B000215"]);
    // 4회차째는 다시 처음으로 — 원형 순환.
    const fourth = selectRotationCourts(courts3, start, 1);
    expect(fourth.selectedCourts[0]!.courtCode).toBe("B000210");
  });

  it("6회차를 돌리면 각 법원이 정확히 두 번씩 수집된다(2.3)", () => {
    let start: string | null = null;
    const counts = new Map<string, number>();
    for (let i = 0; i < 6; i += 1) {
      const { selectedCourts, nextStartCourtCode } = selectRotationCourts(courts3, start, 1);
      const code = selectedCourts[0]!.courtCode;
      counts.set(code, (counts.get(code) ?? 0) + 1);
      start = nextStartCourtCode;
    }
    expect(counts.get("B000210")).toBe(2);
    expect(counts.get("B000211")).toBe(2);
    expect(counts.get("B000215")).toBe(2);
  });

  it("법원 1곳 + 상한 1곳이면 매 회차 같은 법원을 가리킨다 — 회귀(2.4/D5)", () => {
    let start: string | null = null;
    for (let i = 0; i < 5; i += 1) {
      const { selectedCourts, nextStartCourtCode } = selectRotationCourts(singleCourt, start, 1);
      expect(selectedCourts.map((c) => c.courtCode)).toEqual(["B000210"]);
      expect(nextStartCourtCode).toBe("B000210");
      start = nextStartCourtCode;
    }
  });

  it("저장된 코드가 목록에 없으면(법원 삭제·재정렬) 처음부터 다시 시작한다(2.2)", () => {
    const { selectedCourts } = selectRotationCourts(courts3, "B999999", 1);
    expect(selectedCourts[0]!.courtCode).toBe("B000210");
  });

  it("저장된 코드가 목록 중간을 가리키면 그 위치부터 이어서 순환한다 — 재시작 후 이어서 수집(2.1)", () => {
    const { selectedCourts, nextStartCourtCode } = selectRotationCourts(courts3, "B000211", 1);
    expect(selectedCourts[0]!.courtCode).toBe("B000211");
    expect(nextStartCourtCode).toBe("B000215");
  });

  it("법원이 재정렬돼도 저장된 코드로 올바른 위치를 다시 찾는다(2.2)", () => {
    const reordered: CourtRef[] = [courts3[2]!, courts3[0]!, courts3[1]!]; // B000215, B000210, B000211
    const { selectedCourts, nextStartCourtCode } = selectRotationCourts(
      reordered,
      "B000210",
      1,
    );
    expect(selectedCourts[0]!.courtCode).toBe("B000210");
    expect(nextStartCourtCode).toBe("B000211");
  });

  it("법원이 추가된 뒤에도 저장된 코드를 그대로 찾아 이어서 순환한다(2.2)", () => {
    const expanded: CourtRef[] = [...courts3, { name: "의정부지방법원", courtCode: "B000214" }];
    const { selectedCourts, nextStartCourtCode } = selectRotationCourts(expanded, "B000215", 1);
    expect(selectedCourts[0]!.courtCode).toBe("B000215");
    expect(nextStartCourtCode).toBe("B000214");
  });

  it("상한이 법원 수보다 크면 전부를 한 번씩만 고르고 처음으로 되돌아간다(중복 없음)", () => {
    const { selectedCourts, nextStartCourtCode } = selectRotationCourts(courts3, null, 10);
    expect(selectedCourts.map((c) => c.courtCode)).toEqual(["B000210", "B000211", "B000215"]);
    expect(nextStartCourtCode).toBe("B000210");
  });

  it("상한이 2곳이면 한 회차에 2곳을 고르고 원형으로 겹쳐 넘어간다", () => {
    const first = selectRotationCourts(courts3, null, 2);
    expect(first.selectedCourts.map((c) => c.courtCode)).toEqual(["B000210", "B000211"]);
    expect(first.nextStartCourtCode).toBe("B000215");

    const second = selectRotationCourts(courts3, first.nextStartCourtCode, 2);
    // 마지막 법원(B000215)부터 2개를 원형으로 고르면 B000215, B000210이다.
    expect(second.selectedCourts.map((c) => c.courtCode)).toEqual(["B000215", "B000210"]);
    expect(second.nextStartCourtCode).toBe("B000211");
  });

  it("법원 목록이 비어 있으면 던진다(호출자 방어)", () => {
    expect(() => selectRotationCourts([], null, 1)).toThrow();
  });
});

describe("computeLapDurationMs", () => {
  it("법원 1곳 + 상한 1곳이면 한 바퀴 = 주기 1회", () => {
    expect(computeLapDurationMs(1, 1, 600_000)).toBe(600_000);
  });

  it("법원 3곳 + 상한 1곳이면 한 바퀴 = 주기 3회", () => {
    expect(computeLapDurationMs(3, 1, 600_000)).toBe(1_800_000);
  });

  it("나누어떨어지지 않으면 올림한다 — 법원 5곳 + 상한 2곳 = 3회(ceil(5/2))", () => {
    expect(computeLapDurationMs(5, 2, 600_000)).toBe(3 * 600_000);
  });

  it("상한이 법원 수 이상이면 한 바퀴 = 주기 1회", () => {
    expect(computeLapDurationMs(3, 10, 600_000)).toBe(600_000);
  });

  it("법원이 0곳이면 0을 돌려준다(방어적)", () => {
    expect(computeLapDurationMs(0, 1, 600_000)).toBe(0);
  });
});
