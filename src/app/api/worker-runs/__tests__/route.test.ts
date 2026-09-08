/**
 * `POST`/`GET /api/worker-runs` HTTP 경계 테스트.
 *
 * `POST`(회차 시작, add-collection-observability 4.4)와 `GET`(회차 기록 조회, task 5.1)이
 * 같은 파일(`../route.ts`)에 같이 있어 테스트도 한 파일에 둔다.
 *
 * `src/app/api/items/__tests__/route.test.ts`의 패턴을 그대로 따른다 — 서버를 띄우지
 * 않고 라우트 핸들러를 직접 import해서 호출한다. 이 라우트는 저장소 함수
 * (`startRun`/`listWorkerRuns`)를 그대로 호출하는 얇은 층이므로, 저장소 자체의 규칙
 * (design.md D2/D5 등)은 `src/lib/db/__tests__/worker-runs.test.ts`가 고정하고 있고,
 * 여기서는 HTTP 경계(요청 검증 → 저장소 호출 → 응답 JSON)만 확인한다.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { closeDb, finishRun, getWorkerRunsRepository, recordSkippedRun, startRun } from "@/lib/db";

import { GET, POST } from "../route";

const originalEnv = process.env.AUCTIONBOSS_DB;
let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(path.join(tmpdir(), "auctionboss-route-worker-runs-"));
  process.env.AUCTIONBOSS_DB = path.join(workDir, "test.db");
});

afterEach(() => {
  closeDb();
  if (originalEnv === undefined) delete process.env.AUCTIONBOSS_DB;
  else process.env.AUCTIONBOSS_DB = originalEnv;
  rmSync(workDir, { recursive: true, force: true });
});

function request(body: unknown): Request {
  return new Request("http://localhost/api/worker-runs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function malformedRequest(rawBody: string): Request {
  return new Request("http://localhost/api/worker-runs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: rawBody,
  });
}

function getRequest(query: string): Request {
  return new Request(`http://localhost/api/worker-runs${query ? `?${query}` : ""}`);
}

describe("POST /api/worker-runs", () => {
  it("worker='collector'로 시작하면 201과 새 회차 id를 돌려주고, 실제로 running 행이 생긴다", async () => {
    const response = await POST(request({ worker: "collector" }));
    expect(response.status).toBe(201);

    const body = (await response.json()) as { id: number };
    expect(typeof body.id).toBe("number");

    const { runs } = getWorkerRunsRepository().listWorkerRuns({ worker: "collector" });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ id: body.id, worker: "collector", outcome: "running" });
  });

  it("worker='analyzer'로도 시작할 수 있다", async () => {
    const response = await POST(request({ worker: "analyzer" }));
    expect(response.status).toBe(201);

    const { runs } = getWorkerRunsRepository().listWorkerRuns({ worker: "analyzer" });
    expect(runs).toHaveLength(1);
  });

  it("worker 값이 없으면 400과 {error, details:[{field,message}]}를 반환한다", async () => {
    const response = await POST(request({}));
    expect(response.status).toBe(400);

    const body = (await response.json()) as { error: string; details: Array<{ field: string }> };
    expect(typeof body.error).toBe("string");
    expect(body.details).toEqual([{ field: "worker", message: expect.any(String) }]);
  });

  it("worker 값이 목록에 없는 문자열이면 400이다", async () => {
    const response = await POST(request({ worker: "scraper" }));
    expect(response.status).toBe(400);
  });

  it("JSON이 아닌 본문은 400이다", async () => {
    const response = await POST(malformedRequest("이건 JSON이 아니다"));
    expect(response.status).toBe(400);
  });
});

describe("GET /api/worker-runs", () => {
  it("회차 기록이 없으면 오류 없이 빈 목록을 반환한다", async () => {
    const response = GET(getRequest(""));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { runs: unknown[]; total: number };
    expect(body.runs).toEqual([]);
    expect(body.total).toBe(0);
  });

  it("최신 회차가 먼저 오는 목록과 페이지네이션 정보를 반환한다", async () => {
    const runId1 = startRun("collector");
    finishRun(runId1, { outcome: "success" });
    const runId2 = startRun("collector");
    finishRun(runId2, { outcome: "success" });

    const response = GET(getRequest(""));
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      runs: Array<{ id: number }>;
      total: number;
      page: number;
      pageSize: number;
    };
    expect(body.total).toBe(2);
    expect(body.page).toBe(1);
    expect(body.pageSize).toBe(20);
    // 최신순 — 나중에 끝난 runId2가 먼저.
    expect(body.runs.map((run) => run.id)).toEqual([runId2, runId1]);
  });

  it("worker·outcome으로 필터링한다 — 차단 회차만 조회", async () => {
    const okRun = startRun("collector");
    finishRun(okRun, { outcome: "success" });
    const blockedRun = startRun("collector");
    finishRun(blockedRun, { outcome: "blocked", errorKind: "RobotDetectedError" });
    recordSkippedRun("analyzer", "overlap");

    const response = GET(getRequest("worker=collector&outcome=blocked"));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { runs: Array<{ id: number; outcome: string }> };
    expect(body.runs).toHaveLength(1);
    expect(body.runs[0]?.id).toBe(blockedRun);
    expect(body.runs[0]?.outcome).toBe("blocked");
  });

  it("page·pageSize로 페이지네이션한다", async () => {
    for (let i = 0; i < 3; i += 1) {
      const runId = startRun("collector");
      finishRun(runId, { outcome: "success" });
    }

    const response = GET(getRequest("pageSize=2&page=2"));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { runs: unknown[]; page: number; pageSize: number };
    expect(body.page).toBe(2);
    expect(body.pageSize).toBe(2);
    expect(body.runs).toHaveLength(1);
  });

  it("worker가 인식되지 않는 값이면 400과 {error, details:[{field,message}]}를 반환한다", async () => {
    const response = GET(getRequest("worker=nope"));
    expect(response.status).toBe(400);
    const body = (await response.json()) as {
      error: string;
      details: Array<{ field: string; message: string }>;
    };
    expect(typeof body.error).toBe("string");
    expect(body.details).toEqual([{ field: "worker", message: expect.any(String) }]);
  });

  it("outcome이 인식되지 않는 값이면 400이다", async () => {
    const response = GET(getRequest("outcome=nope"));
    expect(response.status).toBe(400);
    const body = (await response.json()) as { details: Array<{ field: string }> };
    expect(body.details).toEqual([{ field: "outcome", message: expect.any(String) }]);
  });

  it("page=0처럼 범위를 벗어난 값은 400이다", async () => {
    const response = GET(getRequest("page=0"));
    expect(response.status).toBe(400);
    const body = (await response.json()) as { details: Array<{ field: string }> };
    expect(body.details.some((d) => d.field === "page")).toBe(true);
  });

  it("pageSize가 상한을 넘으면 400이다", async () => {
    const response = GET(getRequest("pageSize=1000"));
    expect(response.status).toBe(400);
    const body = (await response.json()) as { details: Array<{ field: string }> };
    expect(body.details.some((d) => d.field === "pageSize")).toBe(true);
  });

  it("인식된 파라미터가 빈 값(?worker=)이면 400이다", async () => {
    const response = GET(getRequest("worker="));
    expect(response.status).toBe(400);
    const body = (await response.json()) as { details: Array<{ field: string }> };
    expect(body.details.some((d) => d.field === "worker")).toBe(true);
  });
});
