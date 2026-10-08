import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { SCENARIOS_DIR, generateAll, stepTimeMs } from "../generate-scenarios";
import { SCENARIOS } from "../scenarios";

describe("시나리오 골든 생성", () => {
  it("결정적이고, 커밋된 골든과 바이트까지 같고, 형식 표식이 없다", async () => {
    const first = await generateAll();
    const second = await generateAll();
    expect([...second.files]).toEqual([...first.files]);
    expect(first.isoMsMarkers).toBe(0);

    const committed = readdirSync(SCENARIOS_DIR).filter((f) => f.endsWith(".json")).sort();
    expect(committed).toEqual([...first.files.keys()].sort());
    for (const [name, text] of first.files) {
      expect(text, name).toBe(readFileSync(path.join(SCENARIOS_DIR, name), "utf8"));
    }
  }, 120_000);

  it("10개 시나리오를 정의하고 원본이 500을 낸 단계가 없다", async () => {
    expect(SCENARIOS.map((s) => s.name)).toEqual([
      "worker-runs-lifecycle",
      "worker-runs-errors",
      "worker-runs-prune",
      "bookmarks-feed",
      "bookmarks-errors",
      "analyses",
      "photos",
      "screen-reads",
      "worker-status",
      "port-requests",
    ]);
    const { files } = await generateAll();
    for (const text of files.values()) {
      const g = JSON.parse(text) as { steps: { status: number }[] };
      expect(g.steps.every((s) => s.status < 500)).toBe(true);
    }
  }, 120_000);

  it("고정 시각이 응답에 반영된다(단계 i의 서버 시각 = T0 + i초)", async () => {
    const { files } = await generateAll(SCENARIOS.filter((s) => s.name === "worker-runs-lifecycle"));
    const g = JSON.parse(files.get("worker-runs-lifecycle.json")!) as { steps: { body: Record<string, unknown> }[] };
    // 단계 0에서 시작(T0), 단계 1에서 종료(T0+1초)
    expect(g.steps[1].body).toMatchObject({
      startedAt: "2026-10-08T00:00:00.000Z",
      finishedAt: "2026-10-08T00:00:01.000Z",
    });
  }, 120_000);

  it("advanceMs는 그 단계부터 누적되어 서버 시각을 민다", () => {
    const start = Date.parse("2026-10-08T00:00:00.000Z");
    const advances = [undefined, undefined, 5000, undefined, 1000];
    const at = (i: number) => new Date(stepTimeMs(start, 1000, advances, i)).toISOString();
    expect(at(0)).toBe("2026-10-08T00:00:00.000Z");
    expect(at(1)).toBe("2026-10-08T00:00:01.000Z");
    expect(at(2)).toBe("2026-10-08T00:00:07.000Z"); // 2초 + 5초
    expect(at(3)).toBe("2026-10-08T00:00:08.000Z"); // 이후 단계도 밀린 채로
    expect(at(4)).toBe("2026-10-08T00:00:10.000Z"); // 4초 + 5초 + 1초
  });

  it("worker-status: 시각 이동 단계가 미실행 판정을 만들고 성공 시각은 유지된다", async () => {
    const { files } = await generateAll(SCENARIOS.filter((s) => s.name === "worker-status"));
    const g = JSON.parse(files.get("worker-status.json")!) as {
      steps: { advanceMs?: number; request: { query: string }; body: { state: string; lastSuccessAt: string | null } }[];
    };
    const moved = g.steps.findIndex((s) => s.advanceMs !== undefined);
    expect(moved).toBeGreaterThan(0);
    expect(g.steps[moved - 1].body.state).toBe("failed");
    expect(g.steps[moved].body.state).toBe("stale");
    expect(g.steps[moved].body.lastSuccessAt).toBe(g.steps[moved - 1].body.lastSuccessAt);
    const states = new Set(g.steps.map((s) => s.body.state));
    for (const state of ["ok", "blocked", "failed", "stale"]) expect(states.has(state)).toBe(true);
  }, 120_000);
});
