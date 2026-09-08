/**
 * `GET /api/worker-runs/summary` HTTP 경계 테스트(design.md D1/D5, 스펙 "회차 기록 조회").
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { closeDb, finishRun, startRun } from "@/lib/db";

import { GET } from "../route";

const originalEnv = process.env.AUCTIONBOSS_DB;
let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(path.join(tmpdir(), "auctionboss-route-worker-runs-summary-"));
  process.env.AUCTIONBOSS_DB = path.join(workDir, "test.db");
});

afterEach(() => {
  closeDb();
  if (originalEnv === undefined) delete process.env.AUCTIONBOSS_DB;
  else process.env.AUCTIONBOSS_DB = originalEnv;
  rmSync(workDir, { recursive: true, force: true });
});

function request(query: string): Request {
  return new Request(`http://localhost/api/worker-runs/summary${query ? `?${query}` : ""}`);
}

describe("GET /api/worker-runs/summary", () => {
  it("회차 기록이 없으면 successRate가 null이다(0%과 구분)", async () => {
    const response = GET(request(""));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { successRate: number | null; totalRuns: number };
    expect(body.successRate).toBeNull();
    expect(body.totalRuns).toBe(0);
  });

  it("성공률·차단 횟수·누적 변경 건수를 반환한다", async () => {
    const run1 = startRun("collector");
    finishRun(run1, {
      outcome: "success",
      detail: { targetCourts: [], pagesRequested: 1, itemsFetched: 5, inserted: 2, updated: 3, changed: 4 },
    });
    const run2 = startRun("collector");
    finishRun(run2, { outcome: "blocked", errorKind: "RobotDetectedError" });

    const response = GET(request("worker=collector"));
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      successRate: number | null;
      blockedCount: number;
      itemsChanged: number;
    };
    expect(body.successRate).toBe(0.5);
    expect(body.blockedCount).toBe(1);
    expect(body.itemsChanged).toBe(4);
  });

  it("worker가 인식되지 않는 값이면 400이다", async () => {
    const response = GET(request("worker=nope"));
    expect(response.status).toBe(400);
    const body = (await response.json()) as { details: Array<{ field: string }> };
    expect(body.details).toEqual([{ field: "worker", message: expect.any(String) }]);
  });

  it("since가 올바른 날짜가 아니면 400이다", async () => {
    const response = GET(request("since=not-a-date"));
    expect(response.status).toBe(400);
    const body = (await response.json()) as { details: Array<{ field: string }> };
    expect(body.details.some((d) => d.field === "since")).toBe(true);
  });

  it("since 이후의 회차만 집계한다", async () => {
    const oldRun = startRun("collector", { now: "2020-01-01T00:00:00.000Z" });
    finishRun(oldRun, { outcome: "success" }, { now: "2020-01-01T00:01:00.000Z" });
    const newRun = startRun("collector", { now: "2026-01-01T00:00:00.000Z" });
    finishRun(newRun, { outcome: "success" }, { now: "2026-01-01T00:01:00.000Z" });

    const response = GET(request("since=2025-01-01T00:00:00.000Z"));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { totalRuns: number };
    expect(body.totalRuns).toBe(1);
  });
});
