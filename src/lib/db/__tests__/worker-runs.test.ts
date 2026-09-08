import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
  AnalyzerRunDetail,
  CollectorConfig,
  CollectorRunDetail,
} from "@/lib/domain";
import { openDatabase, type Db } from "../client";
import { WorkerRunNotFoundError } from "../errors";
import { createWorkerRunsRepository, type WorkerRunsRepository } from "../worker-runs";

/**
 * 모든 테스트는 인메모리 DB를 쓴다 — env(`AUCTIONBOSS_DB`)나 실제 `data/` 디렉터리를
 * 건드리지 않기 위함(repository.test.ts와 같은 관례).
 */
let db: Db;
let repo: WorkerRunsRepository;

beforeEach(() => {
  db = openDatabase(":memory:");
  repo = createWorkerRunsRepository(db);
});

afterEach(() => {
  db.close();
});

/**
 * 테스트가 실제 config/collector.json에 기대지 않도록 매번 명시적으로 config를 만든다
 * (design.md D5/D6: 기대 주기·보관 상한은 항상 config에서 읽고 하드코딩하지 않는다 —
 * 그 config를 테스트에서 자유롭게 주입할 수 있어야 결정적으로 검증할 수 있다).
 */
function makeConfig(overrides: Partial<CollectorConfig> = {}): CollectorConfig {
  return {
    scope: {
      courts: [{ name: "서울중앙지방법원", courtCode: "B000210" }],
      maxCourtsPerRun: 1,
      maxRequestsPerRun: 13,
    },
    intervalMs: 10 * 60 * 1000, // collector 10분
    analysis: {
      maxItemsPerRun: 5,
      maxReanalysisPerRun: 2,
      reanalysisCooldownHours: 24,
      intervalMs: 10 * 60 * 1000, // analyzer 10분
    },
    observability: { maxRunsPerWorker: 1000, staleAfterIntervals: 3 },
    ...overrides,
  };
}

function collectorDetail(overrides: Partial<CollectorRunDetail> = {}): CollectorRunDetail {
  return {
    targetCourts: ["서울중앙지방법원"],
    pagesRequested: 3,
    itemsFetched: 30,
    inserted: 5,
    updated: 20,
    changed: 4,
    ...overrides,
  };
}

function analyzerDetail(overrides: Partial<AnalyzerRunDetail> = {}): AnalyzerRunDetail {
  return { newCount: 2, reanalysisCount: 1, succeeded: 3, failed: 0, ...overrides };
}

describe("startRun/finishRun", () => {
  it("startRun은 running 행을 만들고, 종료 전에도 조회 가능하다(design.md D2)", () => {
    const runId = repo.startRun("collector", {
      now: "2026-01-01T00:00:00.000Z",
      config: makeConfig(),
    });

    const { runs } = repo.listWorkerRuns({ worker: "collector" });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      id: runId,
      worker: "collector",
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: null,
      outcome: "running",
      detail: null,
      itemsChanged: null,
    });
  });

  it("워커가 회차 도중 죽어도(끝내 finishRun이 안 불려도) 회차 존재가 남는다", () => {
    const runId = repo.startRun("collector", {
      now: "2026-01-01T00:00:00.000Z",
      config: makeConfig(),
    });

    // finishRun을 호출하지 않은 채로 다시 조회 — 여전히 running으로 남아 있어야 한다.
    const { runs } = repo.listWorkerRuns({ worker: "collector", outcome: "running" });
    expect(runs.map((r) => r.id)).toContain(runId);
  });

  it("finishRun은 시작된 회차를 결과와 함께 갱신한다", () => {
    const runId = repo.startRun("collector", {
      now: "2026-01-01T00:00:00.000Z",
      config: makeConfig(),
    });

    const updated = repo.finishRun(
      runId,
      { outcome: "success", detail: collectorDetail() },
      { now: "2026-01-01T00:10:00.000Z" },
    );

    expect(updated).toMatchObject({
      id: runId,
      outcome: "success",
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:10:00.000Z",
      detail: collectorDetail(),
    });
  });

  it("차단 회차는 failed와 구별된 outcome으로, 오류 종류와 함께 기록된다", () => {
    const runId = repo.startRun("collector", { config: makeConfig() });
    const updated = repo.finishRun(runId, {
      outcome: "blocked",
      errorKind: "RobotDetectedError",
      errorMessage: "로봇 탐지 차단",
    });

    expect(updated.outcome).toBe("blocked");
    expect(updated.errorKind).toBe("RobotDetectedError");
    expect(updated.errorMessage).toBe("로봇 탐지 차단");
  });

  it("일반 실패 회차는 오류 종류와 메시지가 남는다", () => {
    const runId = repo.startRun("collector", { config: makeConfig() });
    const updated = repo.finishRun(runId, {
      outcome: "failed",
      errorKind: "ResponseSchemaError",
      errorMessage: "응답 형식이 바뀌었습니다",
    });

    expect(updated.outcome).toBe("failed");
    expect(updated.errorKind).toBe("ResponseSchemaError");
  });

  it("존재하지 않는 회차를 finishRun하면 WorkerRunNotFoundError를 던진다", () => {
    expect(() => repo.finishRun(999999, { outcome: "success" })).toThrow(WorkerRunNotFoundError);
  });
});

describe("recordSkippedRun", () => {
  it("시작·종료가 같은 순간으로 한 번에 기록되고, 사유가 error_kind에 남는다(design.md D1)", () => {
    const run = repo.recordSkippedRun("collector", "overlap", {
      now: "2026-01-01T00:00:00.000Z",
      config: makeConfig(),
    });

    expect(run).toMatchObject({
      worker: "collector",
      outcome: "skipped",
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:00:00.000Z",
      errorKind: "overlap",
    });
  });

  it("backoff 사유는 overlap과 구별된다", () => {
    const run = repo.recordSkippedRun("collector", "backoff", { config: makeConfig() });
    expect(run.errorKind).toBe("backoff");
  });
});

describe("detail JSON과 items_changed 컬럼의 동기화(design.md D1 위험)", () => {
  it("collector detail의 changed와 items_changed 컬럼이 항상 일치한다", () => {
    const runId = repo.startRun("collector", { config: makeConfig() });
    const updated = repo.finishRun(runId, {
      outcome: "success",
      detail: collectorDetail({ changed: 7 }),
    });

    expect(updated.itemsChanged).toBe(7);
    expect(updated.detail).toMatchObject({ changed: 7 });

    // raw 행으로도 직접 확인 — 저장소가 반환하는 값과 DB에 실제로 저장된 값이 같은지.
    const raw = db
      .prepare<{ id: number }, { detail: string; items_changed: number | null }>(
        "SELECT detail, items_changed FROM worker_runs WHERE id = @id",
      )
      .get({ id: runId });
    expect(raw?.items_changed).toBe(7);
    expect(JSON.parse(raw!.detail).changed).toBe(7);
  });

  it("analyzer detail(집계 가능한 changed가 없음)은 items_changed가 null이다", () => {
    const runId = repo.startRun("analyzer", { config: makeConfig() });
    const updated = repo.finishRun(runId, {
      outcome: "success",
      detail: analyzerDetail(),
    });

    expect(updated.itemsChanged).toBeNull();
  });

  it("detail이 없는 회차는 items_changed도 null이다", () => {
    const runId = repo.startRun("collector", { config: makeConfig() });
    const updated = repo.finishRun(runId, { outcome: "failed", errorKind: "SourceRequestError" });
    expect(updated.itemsChanged).toBeNull();
    expect(updated.detail).toBeNull();
  });
});

describe("보관 상한 정리(design.md D6)", () => {
  it("상한을 넘겨 기록하면 오래된 것만 삭제되고 최근 것이 보존된다", () => {
    const config = makeConfig({ observability: { maxRunsPerWorker: 3, staleAfterIntervals: 3 } });

    const ids: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      const now = `2026-01-01T00:0${i}:00.000Z`;
      ids.push(repo.startRun("collector", { now, config }));
    }

    const { runs, total } = repo.listWorkerRuns({ worker: "collector", pageSize: 10 });
    expect(total).toBe(3);
    // 가장 최근 3개(마지막에 만든 세 개)만 남아야 한다 — 최신순이므로 배열 순서 그대로 확인.
    expect(runs.map((r) => r.id)).toEqual([ids[4], ids[3], ids[2]]);
  });

  it("다른 워커의 기록은 서로의 보관 상한에 영향을 주지 않는다", () => {
    const config = makeConfig({ observability: { maxRunsPerWorker: 1, staleAfterIntervals: 3 } });

    repo.startRun("collector", { now: "2026-01-01T00:00:00.000Z", config });
    repo.startRun("analyzer", { now: "2026-01-01T00:01:00.000Z", config });

    expect(repo.listWorkerRuns({ worker: "collector" }).total).toBe(1);
    expect(repo.listWorkerRuns({ worker: "analyzer" }).total).toBe(1);
  });
});

describe("listWorkerRuns", () => {
  beforeEach(() => {
    const config = makeConfig();
    const r1 = repo.startRun("collector", { now: "2026-01-01T00:00:00.000Z", config });
    repo.finishRun(r1, { outcome: "success", detail: collectorDetail() }, {
      now: "2026-01-01T00:05:00.000Z",
    });

    const r2 = repo.startRun("collector", { now: "2026-01-01T00:10:00.000Z", config });
    repo.finishRun(r2, { outcome: "blocked", errorKind: "RobotDetectedError" }, {
      now: "2026-01-01T00:11:00.000Z",
    });

    repo.recordSkippedRun("collector", "overlap", {
      now: "2026-01-01T00:15:00.000Z",
      config,
    });

    const r4 = repo.startRun("analyzer", { now: "2026-01-01T00:20:00.000Z", config });
    repo.finishRun(r4, { outcome: "success", detail: analyzerDetail() }, {
      now: "2026-01-01T00:21:00.000Z",
    });
  });

  it("최신순으로 반환한다", () => {
    const { runs, total } = repo.listWorkerRuns({ worker: "collector" });
    expect(total).toBe(3);
    expect(runs.map((r) => r.outcome)).toEqual(["skipped", "blocked", "success"]);
  });

  it("worker로 필터한다", () => {
    const { runs, total } = repo.listWorkerRuns({ worker: "analyzer" });
    expect(total).toBe(1);
    expect(runs[0]?.outcome).toBe("success");
  });

  it("outcome으로 필터한다(차단 회차만)", () => {
    const { runs, total } = repo.listWorkerRuns({ outcome: "blocked" });
    expect(total).toBe(1);
    expect(runs[0]?.errorKind).toBe("RobotDetectedError");
  });

  it("페이지네이션이 동작한다", () => {
    const page1 = repo.listWorkerRuns({ worker: "collector", page: 1, pageSize: 2 });
    expect(page1.runs).toHaveLength(2);
    expect(page1.total).toBe(3);
    expect(page1.runs.map((r) => r.outcome)).toEqual(["skipped", "blocked"]);

    const page2 = repo.listWorkerRuns({ worker: "collector", page: 2, pageSize: 2 });
    expect(page2.runs).toHaveLength(1);
    expect(page2.runs[0]?.outcome).toBe("success");
  });

  it("기록이 전혀 없으면 빈 목록과 total 0을 돌려준다", () => {
    db.exec("DELETE FROM worker_runs");
    const result = repo.listWorkerRuns({ worker: "collector" });
    expect(result).toEqual({ runs: [], total: 0, page: 1, pageSize: 20 });
  });
});

describe("summarizeRuns", () => {
  it("성공률·차단 횟수·누적 변경 건수를 계산한다", () => {
    const config = makeConfig();
    const r1 = repo.startRun("collector", { now: "2026-01-01T00:00:00.000Z", config });
    repo.finishRun(r1, { outcome: "success", detail: collectorDetail({ changed: 3 }) });

    const r2 = repo.startRun("collector", { now: "2026-01-01T00:10:00.000Z", config });
    repo.finishRun(r2, { outcome: "success", detail: collectorDetail({ changed: 5 }) });

    const r3 = repo.startRun("collector", { now: "2026-01-01T00:20:00.000Z", config });
    repo.finishRun(r3, { outcome: "blocked", errorKind: "WafBlockedError" });

    const r4 = repo.startRun("collector", { now: "2026-01-01T00:30:00.000Z", config });
    repo.finishRun(r4, { outcome: "failed", errorKind: "SourceRequestError" });

    repo.recordSkippedRun("collector", "overlap", { now: "2026-01-01T00:40:00.000Z", config });

    const summary = repo.summarizeRuns({ worker: "collector" });
    expect(summary.successCount).toBe(2);
    expect(summary.failedCount).toBe(1);
    expect(summary.blockedCount).toBe(1);
    expect(summary.skippedCount).toBe(1);
    expect(summary.successRate).toBeCloseTo(2 / 4);
    expect(summary.itemsChanged).toBe(8);
  });

  it("since로 기간을 제한한다", () => {
    const config = makeConfig();
    const r1 = repo.startRun("collector", { now: "2026-01-01T00:00:00.000Z", config });
    repo.finishRun(r1, { outcome: "success", detail: collectorDetail({ changed: 1 }) });

    const r2 = repo.startRun("collector", { now: "2026-02-01T00:00:00.000Z", config });
    repo.finishRun(r2, { outcome: "success", detail: collectorDetail({ changed: 2 }) });

    const summary = repo.summarizeRuns({ worker: "collector", since: "2026-01-15T00:00:00.000Z" });
    expect(summary.successCount).toBe(1);
    expect(summary.itemsChanged).toBe(2);
  });

  it("기록이 전혀 없으면 successRate는 null이고 나머지는 0이다(빈 데이터 케이스)", () => {
    const summary = repo.summarizeRuns({ worker: "collector" });
    expect(summary).toEqual({
      totalRuns: 0,
      successCount: 0,
      failedCount: 0,
      blockedCount: 0,
      skippedCount: 0,
      runningCount: 0,
      successRate: null,
      itemsChanged: 0,
    });
  });
});

describe("getWorkerStatus(design.md D5)", () => {
  const now = "2026-01-01T12:00:00.000Z";

  it("기록이 전혀 없으면 stale이다", () => {
    const status = repo.getWorkerStatus("collector", { now, config: makeConfig() });
    expect(status).toEqual({ state: "stale", lastSuccessAt: null, lastRun: null });
  });

  it("최근 성공 회차가 있으면 ok이고 마지막 성공 시각이 함께 제공된다", () => {
    const config = makeConfig(); // intervalMs 10분
    const r1 = repo.startRun("collector", { now: "2026-01-01T11:55:00.000Z", config });
    repo.finishRun(
      r1,
      { outcome: "success", detail: collectorDetail() },
      { now: "2026-01-01T11:58:00.000Z" },
    );

    const status = repo.getWorkerStatus("collector", { now, config });
    expect(status.state).toBe("ok");
    expect(status.lastSuccessAt).toBe("2026-01-01T11:58:00.000Z");
  });

  it("마지막 성공이 기대 주기 × N보다 오래되면 stale이다", () => {
    // intervalMs=10분, staleAfterIntervals=3 → 임계값 30분. 마지막 성공이 40분 전.
    const config = makeConfig();
    const r1 = repo.startRun("collector", { now: "2026-01-01T11:20:00.000Z", config });
    repo.finishRun(
      r1,
      { outcome: "success", detail: collectorDetail() },
      { now: "2026-01-01T11:20:00.000Z" },
    );

    const status = repo.getWorkerStatus("collector", { now, config });
    expect(status.state).toBe("stale");
    expect(status.lastSuccessAt).toBe("2026-01-01T11:20:00.000Z");
  });

  it("성공 기록이 한 번도 없는 채로 오래된 running 고아 행만 있으면 stale이다(finishRun 실패로 남은 고아)", () => {
    const config = makeConfig();
    // finishRun이 끝내 호출되지 않은 오래된 running 회차 — 40분 전에 시작, 여전히 running.
    repo.startRun("collector", { now: "2026-01-01T11:20:00.000Z", config });

    const status = repo.getWorkerStatus("collector", { now, config });
    expect(status.state).toBe("stale");
    expect(status.lastSuccessAt).toBeNull();
  });

  it("가장 최근 완료된 회차가 blocked이면 blocked다", () => {
    const config = makeConfig();
    const r1 = repo.startRun("collector", { now: "2026-01-01T11:55:00.000Z", config });
    repo.finishRun(
      r1,
      { outcome: "blocked", errorKind: "RobotDetectedError" },
      { now: "2026-01-01T11:56:00.000Z" },
    );

    const status = repo.getWorkerStatus("collector", { now, config });
    expect(status.state).toBe("blocked");
  });

  it("가장 최근 완료된 회차가 failed이면 failed다", () => {
    const config = makeConfig();
    const r1 = repo.startRun("collector", { now: "2026-01-01T11:55:00.000Z", config });
    repo.finishRun(
      r1,
      { outcome: "failed", errorKind: "ResponseSchemaError" },
      { now: "2026-01-01T11:56:00.000Z" },
    );

    const status = repo.getWorkerStatus("collector", { now, config });
    expect(status.state).toBe("failed");
  });

  it("overlap 건너뜀은 최근 회차로 취급되지 않는다 — 직전 성공에 이은 skip은 ok를 그대로 유지한다", () => {
    const config = makeConfig();
    const r1 = repo.startRun("collector", { now: "2026-01-01T11:50:00.000Z", config });
    repo.finishRun(
      r1,
      { outcome: "success", detail: collectorDetail() },
      { now: "2026-01-01T11:52:00.000Z" },
    );
    repo.recordSkippedRun("collector", "overlap", { now: "2026-01-01T11:58:00.000Z", config });

    const status = repo.getWorkerStatus("collector", { now, config });
    expect(status.state).toBe("ok");
  });

  it("backoff 건너뜀은 최근 회차로 취급되지 않는다 — 직전 blocked에 이은 skip도 blocked를 유지한다", () => {
    const config = makeConfig();
    const r1 = repo.startRun("collector", { now: "2026-01-01T11:50:00.000Z", config });
    repo.finishRun(
      r1,
      { outcome: "blocked", errorKind: "RobotDetectedError" },
      { now: "2026-01-01T11:52:00.000Z" },
    );
    repo.recordSkippedRun("collector", "backoff", { now: "2026-01-01T11:58:00.000Z", config });

    const status = repo.getWorkerStatus("collector", { now, config });
    expect(status.state).toBe("blocked");
  });

  it("기대 주기는 config에서 읽는다 — 같은 기록도 config가 다르면 판정이 달라진다", () => {
    // 마지막 성공이 20분 전. staleAfterIntervals=3 기준:
    // intervalMs=10분이면 임계값 30분 → stale 아님(ok).
    // intervalMs=5분이면 임계값 15분 → stale.
    const r1 = repo.startRun("collector", {
      now: "2026-01-01T11:40:00.000Z",
      config: makeConfig(),
    });
    repo.finishRun(
      r1,
      { outcome: "success", detail: collectorDetail() },
      { now: "2026-01-01T11:40:00.000Z" },
    );

    const okStatus = repo.getWorkerStatus("collector", {
      now,
      config: makeConfig({ intervalMs: 10 * 60 * 1000 }),
    });
    expect(okStatus.state).toBe("ok");

    const staleStatus = repo.getWorkerStatus("collector", {
      now,
      config: makeConfig({ intervalMs: 5 * 60 * 1000 }),
    });
    expect(staleStatus.state).toBe("stale");
  });

  it("analyzer의 기대 주기는 collector와 별개로 config.analysis.intervalMs에서 읽는다", () => {
    // collector.intervalMs는 넉넉하게(60분), analyzer.intervalMs는 짧게(5분) 설정해
    // 같은 절대 경과 시간(20분 전 성공)이 워커별로 다르게 판정되는지 확인한다.
    const config = makeConfig({
      intervalMs: 60 * 60 * 1000,
      analysis: {
        maxItemsPerRun: 5,
        maxReanalysisPerRun: 2,
        reanalysisCooldownHours: 24,
        intervalMs: 5 * 60 * 1000,
      },
    });

    const collectorRun = repo.startRun("collector", { now: "2026-01-01T11:40:00.000Z", config });
    repo.finishRun(
      collectorRun,
      { outcome: "success", detail: collectorDetail() },
      { now: "2026-01-01T11:40:00.000Z" },
    );
    const analyzerRun = repo.startRun("analyzer", { now: "2026-01-01T11:40:00.000Z", config });
    repo.finishRun(
      analyzerRun,
      { outcome: "success", detail: analyzerDetail() },
      { now: "2026-01-01T11:40:00.000Z" },
    );

    expect(repo.getWorkerStatus("collector", { now, config }).state).toBe("ok");
    expect(repo.getWorkerStatus("analyzer", { now, config }).state).toBe("stale");
  });
});
