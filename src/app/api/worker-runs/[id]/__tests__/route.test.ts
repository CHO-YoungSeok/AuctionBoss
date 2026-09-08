/**
 * `PATCH /api/worker-runs/[id]` HTTP 경계 테스트(add-collection-observability 4.4).
 *
 * `src/app/api/items/[id]/changes/__tests__/route.test.ts`의 패턴을 그대로 따른다.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { closeDb, getWorkerRunsRepository } from "@/lib/db";

import { PATCH } from "../route";

const originalEnv = process.env.AUCTIONBOSS_DB;
let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(path.join(tmpdir(), "auctionboss-route-worker-run-finish-"));
  process.env.AUCTIONBOSS_DB = path.join(workDir, "test.db");
});

afterEach(() => {
  closeDb();
  if (originalEnv === undefined) delete process.env.AUCTIONBOSS_DB;
  else process.env.AUCTIONBOSS_DB = originalEnv;
  rmSync(workDir, { recursive: true, force: true });
});

function request(id: string, body: unknown): Request {
  return new Request(`http://localhost/api/worker-runs/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function malformedRequest(id: string, rawBody: string): Request {
  return new Request(`http://localhost/api/worker-runs/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: rawBody,
  });
}

function context(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

describe("PATCH /api/worker-runs/[id]", () => {
  it("analyzer detail로 success 종료하면 200과 갱신된 회차를 돌려주고, 저장소에 반영된다", async () => {
    const runId = getWorkerRunsRepository().startRun("analyzer");

    const response = await PATCH(
      request(String(runId), {
        outcome: "success",
        detail: { newCount: 2, reanalysisCount: 1, succeeded: 3, failed: 0 },
      }),
      context(String(runId)),
    );
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      id: number;
      outcome: string;
      detail: unknown;
      finishedAt: string | null;
    };
    expect(body.outcome).toBe("success");
    expect(body.finishedAt).not.toBeNull();
    expect(body.detail).toEqual({ newCount: 2, reanalysisCount: 1, succeeded: 3, failed: 0 });

    const stored = getWorkerRunsRepository().listWorkerRuns({ worker: "analyzer" }).runs[0];
    expect(stored?.outcome).toBe("success");
  });

  it("collector detail과 errorKind로 blocked 종료할 수 있다", async () => {
    const runId = getWorkerRunsRepository().startRun("collector");

    const response = await PATCH(
      request(String(runId), {
        outcome: "blocked",
        errorKind: "RobotDetectedError",
        errorMessage: "로봇탐지 차단",
        detail: {
          targetCourts: ["서울중앙지방법원"],
          pagesRequested: 5,
          itemsFetched: 0,
          inserted: 0,
          updated: 0,
          changed: 0,
        },
      }),
      context(String(runId)),
    );
    expect(response.status).toBe(200);

    const body = (await response.json()) as { outcome: string; errorKind: string | null };
    expect(body.outcome).toBe("blocked");
    expect(body.errorKind).toBe("RobotDetectedError");
  });

  it("존재하지 않는 회차 id는 404다(WorkerRunNotFoundError)", async () => {
    const response = await PATCH(request("999999", { outcome: "success" }), context("999999"));
    expect(response.status).toBe(404);

    const body = (await response.json()) as { error: string };
    expect(typeof body.error).toBe("string");
  });

  it("숫자가 아닌 id도 404다(존재하지 않는 회차와 같게 취급)", async () => {
    const response = await PATCH(
      request("not-a-number", { outcome: "success" }),
      context("not-a-number"),
    );
    expect(response.status).toBe(404);
  });

  it("outcome이 없으면 400이다", async () => {
    const runId = getWorkerRunsRepository().startRun("collector");
    const response = await PATCH(request(String(runId), {}), context(String(runId)));
    expect(response.status).toBe(400);

    const body = (await response.json()) as { details: Array<{ field: string }> };
    expect(body.details.some((d) => d.field === "outcome")).toBe(true);
  });

  it("outcome='running'이나 'skipped'는 이 엔드포인트로 종료할 수 없다(400)", async () => {
    const runId = getWorkerRunsRepository().startRun("collector");
    const response = await PATCH(
      request(String(runId), { outcome: "running" }),
      context(String(runId)),
    );
    expect(response.status).toBe(400);
  });

  it("detail이 collector·analyzer 어느 쪽 형태와도 안 맞으면 400이다", async () => {
    const runId = getWorkerRunsRepository().startRun("collector");
    const response = await PATCH(
      request(String(runId), { outcome: "success", detail: { nonsense: true } }),
      context(String(runId)),
    );
    expect(response.status).toBe(400);
  });

  it("JSON이 아닌 본문은 400이다", async () => {
    const runId = getWorkerRunsRepository().startRun("collector");
    const response = await PATCH(
      malformedRequest(String(runId), "이건 JSON이 아니다"),
      context(String(runId)),
    );
    expect(response.status).toBe(400);
  });
});
