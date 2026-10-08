/**
 * `GET /api/worker-runs/status` HTTP 경계 테스트(switch-web-to-data-port 3.1).
 * 판정 규칙 자체(`getWorkerStatus`)는 `worker-runs.test.ts`가 검증한다. 여기서는 파라미터 검증, 판정 연결,
 * 워커별 기대 주기, 정적 경로가 `[id]`에 잡히지 않는지를 본다.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { closeDb, finishRun, startRun } from "@/lib/db";

import { PATCH } from "../../[id]/route";
import { GET } from "../route";

const originalEnv = process.env.AUCTIONBOSS_DB;
const originalConfig = process.env.AUCTIONBOSS_CONFIG;
let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(path.join(tmpdir(), "auctionboss-route-"));
  process.env.AUCTIONBOSS_DB = path.join(workDir, "test.db");
});

afterEach(() => {
  closeDb();
  if (originalEnv === undefined) delete process.env.AUCTIONBOSS_DB;
  else process.env.AUCTIONBOSS_DB = originalEnv;
  if (originalConfig === undefined) delete process.env.AUCTIONBOSS_CONFIG;
  else process.env.AUCTIONBOSS_CONFIG = originalConfig;
  rmSync(workDir, { recursive: true, force: true });
});

function call(query: string) {
  return GET(new Request(`http://localhost/api/worker-runs/status${query ? `?${query}` : ""}`));
}

interface Body {
  state?: string;
  lastSuccessAt?: string | null;
  lastRun?: { id: number; outcome: string } | null;
  details?: { field: string }[];
}

describe("GET /api/worker-runs/status", () => {
  it("기록 없는 워커는 stale, lastSuccessAt·lastRun은 null이다", async () => {
    const response = call("worker=collector");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ state: "stale", lastSuccessAt: null, lastRun: null });
  });

  it("방금 성공한 워커는 ok이고 lastRun은 그 회차다", async () => {
    const id = startRun("analyzer");
    finishRun(id, { outcome: "success" });
    const body = (await call("worker=analyzer").json()) as Body;
    expect(body.state).toBe("ok");
    expect(body.lastRun?.id).toBe(id);
    expect(body.lastSuccessAt).not.toBeNull();
  });

  it("차단으로 끝난 뒤 진행 중 회차가 있어도 blocked다", async () => {
    finishRun(startRun("collector"), { outcome: "success" });
    finishRun(startRun("collector"), { outcome: "blocked", errorKind: "blocked" });
    const running = startRun("collector");
    const body = (await call("worker=collector").json()) as Body;
    expect(body.state).toBe("blocked");
    expect(body.lastRun?.id).toBe(running);
    expect(body.lastRun?.outcome).toBe("running");
  });

  it("워커별 기대 주기를 쓴다 — 같은 시각의 성공이라도 주기가 긴 워커만 ok다", async () => {
    const base = JSON.parse(
      readFileSync(path.resolve(__dirname, "../../../../../../config/collector.json"), "utf8"),
    ) as {
      intervalMs: number;
      analysis: { intervalMs: number };
      photos: { intervalMs: number };
      observability: { staleAfterIntervals: number };
    };
    base.intervalMs = 1;
    base.analysis.intervalMs = 1;
    base.photos.intervalMs = 10 * 365 * 24 * 3600 * 1000;
    base.observability.staleAfterIntervals = 1;
    const configPath = path.join(workDir, "collector.json");
    writeFileSync(configPath, JSON.stringify(base));
    process.env.AUCTIONBOSS_CONFIG = configPath;

    const now = new Date(Date.now() - 3_600_000).toISOString();
    for (const worker of ["collector", "analyzer", "photos"] as const) {
      finishRun(startRun(worker, { now }), { outcome: "success" }, { now });
    }
    expect(((await call("worker=photos").json()) as Body).state).toBe("ok");
    expect(((await call("worker=collector").json()) as Body).state).toBe("stale");
    expect(((await call("worker=analyzer").json()) as Body).state).toBe("stale");
  });

  it.each(["", "worker=", "worker=foo", "worker=COLLECTOR"])("%j 는 400이고 details에 worker가 있다", async (query) => {
    const response = call(query);
    expect(response.status).toBe(400);
    const body = (await response.json()) as Body;
    expect(body.details?.map((d) => d.field)).toEqual(["worker"]);
  });

  it("정적 경로 status가 [id]에 잡히지 않는다(PATCH [id]는 별개)", async () => {
    const patch = await PATCH(
      new Request("http://localhost/api/worker-runs/status", {
        method: "PATCH",
        body: JSON.stringify({ outcome: "success" }),
      }),
      { params: Promise.resolve({ id: "status" }) },
    );
    expect(patch.status).toBe(404);
    expect(call("worker=collector").status).toBe(200);
  });
});
