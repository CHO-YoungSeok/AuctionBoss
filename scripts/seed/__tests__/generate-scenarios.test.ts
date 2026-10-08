import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { SCENARIOS_DIR, generateAll } from "../generate-scenarios";
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

  it("7개 시나리오를 정의하고 원본이 500을 낸 단계가 없다", async () => {
    expect(SCENARIOS.map((s) => s.name)).toEqual([
      "worker-runs-lifecycle",
      "worker-runs-errors",
      "worker-runs-prune",
      "bookmarks-feed",
      "bookmarks-errors",
      "analyses",
      "photos",
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
});
