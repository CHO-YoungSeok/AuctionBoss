/**
 * `worker_runs` 저장소 (add-collection-observability, design.md D1/D2/D5/D6).
 *
 * items/analyses 저장소(`repository.ts`)와 같은 관례를 따른다: snake_case ↔ camelCase
 * 변환은 이 파일 안에서 끝나고, `createWorkerRunsRepository(db)`로 연결을 명시해 만들 수
 * 있으며, 모듈 최상단 export 함수들은 기본 싱글턴 연결(`getDb()`)을 쓴다.
 *
 * 이 파일이 책임지는 design 결정들:
 * - D2: 회차는 시작 시 `running` 행을 만들고(`startRun`) 종료 시 같은 행을 갱신한다
 *   (`finishRun`) — 워커가 회차 도중 죽어도 회차의 존재 자체가 남는다.
 * - D1(위험): `detail` JSON의 `changed`와 집계용 `items_changed` 컬럼은 반드시 같은 값이어야
 *   한다. 이 동기화는 `deriveItemsChanged` 하나만 거치므로 호출자가 둘 중 하나만 따로
 *   설정할 방법이 없다(`finishRun`의 시그니처에 `itemsChanged` 파라미터 자체가 없다).
 * - D6: 새 회차(시작/건너뜀)를 기록할 때마다 워커별 보관 상한을 넘는 오래된 행을 정리한다.
 *   조건 분기로 "가끔만" 정리하지 않는다 — 이 규모에서는 매번 해도 무해하다.
 * - D5: `getWorkerStatus`는 상태를 저장하지 않고 매번 기록에서 도출한다. 기대 주기·배수는
 *   호출자가 넘긴 `config`(생략 시 `loadCollectorConfig()`)에서만 읽는다 — 하드코딩하지 않는다.
 */
import {
  loadCollectorConfig,
  type CollectorConfig,
  type CollectorRunDetail,
  type IsoDateTime,
  type RunOutcome,
  type SkipReason,
  type WorkerKind,
  type WorkerRun,
  type WorkerRunDetail,
  type WorkerStatus,
  type WorkerStatusState,
} from "@/lib/domain";

import { getDb, type Db } from "./client";
import { WorkerRunNotFoundError } from "./errors";

interface WorkerRunRow {
  id: number;
  worker: string;
  started_at: string;
  finished_at: string | null;
  outcome: string;
  error_kind: string | null;
  error_message: string | null;
  detail: string | null;
  items_changed: number | null;
}

function toWorkerRun(row: WorkerRunRow): WorkerRun {
  return {
    id: row.id,
    worker: row.worker as WorkerKind,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    outcome: row.outcome as RunOutcome,
    errorKind: row.error_kind,
    errorMessage: row.error_message,
    detail: row.detail ? (JSON.parse(row.detail) as WorkerRunDetail) : null,
    itemsChanged: row.items_changed,
  };
}

/**
 * `detail`과 집계용 `items_changed`를 동기화하는 **유일한** 지점(design.md D1 위험 항목).
 * collector의 `detail`(`CollectorRunDetail`)만 `changed`라는 집계 가능한 수치를 갖는다 —
 * analyzer의 detail이나 detail이 아예 없는 회차는 집계 대상이 아니므로 null이다.
 */
function deriveItemsChanged(detail: WorkerRunDetail | null | undefined): number | null {
  if (detail && typeof (detail as Partial<CollectorRunDetail>).changed === "number") {
    return (detail as CollectorRunDetail).changed;
  }
  return null;
}

function serializeDetail(detail: WorkerRunDetail | null | undefined): string | null {
  return detail == null ? null : JSON.stringify(detail);
}

export interface FinishRunInput {
  outcome: Exclude<RunOutcome, "running" | "skipped">;
  errorKind?: string | null;
  errorMessage?: string | null;
  detail?: WorkerRunDetail | null;
}

export interface WorkerRunQuery {
  worker?: WorkerKind;
  outcome?: RunOutcome;
  page?: number;
  pageSize?: number;
}

export interface ListWorkerRunsResult {
  runs: WorkerRun[];
  total: number;
  page: number;
  pageSize: number;
}

export interface SummarizeRunsQuery {
  worker?: WorkerKind;
  /** 이 시각(포함) 이후에 시작된 회차만 집계한다. 생략하면 보관 중인 전체 기록을 본다. */
  since?: IsoDateTime;
}

export interface RunsSummary {
  totalRuns: number;
  successCount: number;
  failedCount: number;
  blockedCount: number;
  skippedCount: number;
  runningCount: number;
  /**
   * `successCount / (successCount + failedCount + blockedCount)`. 완료된(성공/실패/차단)
   * 회차가 하나도 없으면 계산할 수 없으므로 null이다(0으로 두면 "성공률 0%"와 구별이
   * 안 된다).
   */
  successRate: number | null;
  /** 이 기간 동안 실제로 바뀐 물건 수의 합(`items_changed` 컬럼의 SUM, design.md D1). */
  itemsChanged: number;
}

const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 200;

function normalizePage(page: number | undefined): number {
  if (page === undefined || !Number.isFinite(page)) return DEFAULT_PAGE;
  return Math.max(1, Math.trunc(page));
}

function normalizePageSize(pageSize: number | undefined): number {
  if (pageSize === undefined || !Number.isFinite(pageSize)) return DEFAULT_PAGE_SIZE;
  return Math.min(MAX_PAGE_SIZE, Math.max(1, Math.trunc(pageSize)));
}

export interface WorkerRunsRepository {
  /** `running` 행을 만들고 새로 생긴 회차의 id를 돌려준다(design.md D2). */
  startRun(
    worker: WorkerKind,
    options?: { now?: IsoDateTime; config?: CollectorConfig },
  ): number;
  /** 시작된 회차를 결과와 함께 갱신한다(design.md D2). 존재하지 않는 id면 던진다. */
  finishRun(
    runId: number,
    input: FinishRunInput,
    options?: { now?: IsoDateTime },
  ): WorkerRun;
  /** 시작·종료가 같은 순간인 건너뜀 회차를 한 번에 기록한다(design.md D1/D2). */
  recordSkippedRun(
    worker: WorkerKind,
    reason: SkipReason,
    options?: { now?: IsoDateTime; config?: CollectorConfig },
  ): WorkerRun;
  /** 최신순, 워커·결과 구분으로 필터, 페이지네이션(design.md 스펙 "회차 기록 조회"). */
  listWorkerRuns(query?: WorkerRunQuery): ListWorkerRunsResult;
  /** 성공률·차단 횟수·누적 변경 건수(design.md 스펙 "회차 기록 조회"). */
  summarizeRuns(query?: SummarizeRunsQuery): RunsSummary;
  /** design.md D5의 판정 순서대로 워커의 현재 상태를 도출한다. 저장하지 않는다. */
  getWorkerStatus(
    worker: WorkerKind,
    options?: { now?: IsoDateTime; config?: CollectorConfig },
  ): WorkerStatus;
}

export function createWorkerRunsRepository(db: Db): WorkerRunsRepository {
  const insertRunning = db.prepare(`
    INSERT INTO worker_runs (worker, started_at, outcome, created_at)
    VALUES (@worker, @startedAt, 'running', @createdAt)
  `);

  const updateFinish = db.prepare(`
    UPDATE worker_runs
    SET finished_at = @finishedAt,
        outcome = @outcome,
        error_kind = @errorKind,
        error_message = @errorMessage,
        detail = @detail,
        items_changed = @itemsChanged
    WHERE id = @id
  `);

  const insertSkipped = db.prepare(`
    INSERT INTO worker_runs (worker, started_at, finished_at, outcome, error_kind, created_at)
    VALUES (@worker, @now, @now, 'skipped', @reason, @now)
  `);

  const selectById = db.prepare<{ id: number }, WorkerRunRow>(
    `SELECT * FROM worker_runs WHERE id = @id`,
  );

  const selectLastRun = db.prepare<{ worker: string }, WorkerRunRow>(`
    SELECT * FROM worker_runs WHERE worker = @worker
    ORDER BY started_at DESC, id DESC LIMIT 1
  `);

  const selectLastSuccess = db.prepare<{ worker: string }, WorkerRunRow>(`
    SELECT * FROM worker_runs WHERE worker = @worker AND outcome = 'success'
    ORDER BY started_at DESC, id DESC LIMIT 1
  `);

  // '완료된' 회차만 본다 — running(아직 안 끝남)과 skipped(design.md D5: 최근 회차로
  // 취급하지 않음, 3·4번 판정에서 제외)는 빠진다.
  const selectLastCompleted = db.prepare<{ worker: string }, WorkerRunRow>(`
    SELECT * FROM worker_runs WHERE worker = @worker AND outcome IN ('success', 'failed', 'blocked')
    ORDER BY started_at DESC, id DESC LIMIT 1
  `);

  // 워커별 보관 상한 정리(design.md D6). 최신 @max건만 남기고 나머지를 지운다.
  // 조건부로 "가끔만" 실행하지 않는다 — 하루 144행 규모에서는 매번 해도 무해하고,
  // 분기 자체가 더 비싸다.
  const pruneOldRuns = db.prepare(`
    DELETE FROM worker_runs
    WHERE worker = @worker
      AND id NOT IN (
        SELECT id FROM worker_runs WHERE worker = @worker
        ORDER BY started_at DESC, id DESC LIMIT @max
      )
  `);

  function prune(worker: WorkerKind, config: CollectorConfig): void {
    pruneOldRuns.run({ worker, max: config.observability.maxRunsPerWorker });
  }

  function buildRunFilter(query: WorkerRunQuery): { where: string; params: Record<string, string> } {
    const conditions: string[] = [];
    const params: Record<string, string> = {};
    if (query.worker !== undefined) {
      conditions.push("worker = @worker");
      params.worker = query.worker;
    }
    if (query.outcome !== undefined) {
      conditions.push("outcome = @outcome");
      params.outcome = query.outcome;
    }
    return {
      where: conditions.length === 0 ? "" : `WHERE ${conditions.join(" AND ")}`,
      params,
    };
  }

  return {
    startRun(worker, options) {
      const now = options?.now ?? new Date().toISOString();
      const config = options?.config ?? loadCollectorConfig();
      const info = insertRunning.run({ worker, startedAt: now, createdAt: now });
      const runId = Number(info.lastInsertRowid);
      prune(worker, config);
      return runId;
    },

    finishRun(runId, input, options) {
      const now = options?.now ?? new Date().toISOString();
      const detail = serializeDetail(input.detail);
      const itemsChanged = deriveItemsChanged(input.detail);
      updateFinish.run({
        id: runId,
        finishedAt: now,
        outcome: input.outcome,
        errorKind: input.errorKind ?? null,
        errorMessage: input.errorMessage ?? null,
        detail,
        itemsChanged,
      });
      const row = selectById.get({ id: runId });
      if (!row) throw new WorkerRunNotFoundError(runId);
      return toWorkerRun(row);
    },

    recordSkippedRun(worker, reason, options) {
      const now = options?.now ?? new Date().toISOString();
      const config = options?.config ?? loadCollectorConfig();
      const info = insertSkipped.run({ worker, now, reason });
      const runId = Number(info.lastInsertRowid);
      prune(worker, config);
      const row = selectById.get({ id: runId });
      if (!row) throw new Error("건너뜀 회차 저장 직후 조회에 실패했습니다");
      return toWorkerRun(row);
    },

    listWorkerRuns(query = {}) {
      const page = normalizePage(query.page);
      const pageSize = normalizePageSize(query.pageSize);
      const filter = buildRunFilter(query);

      const total =
        db
          .prepare<Record<string, string>, { total: number }>(
            `SELECT COUNT(*) AS total FROM worker_runs ${filter.where}`,
          )
          .get(filter.params)?.total ?? 0;

      const rows = db
        .prepare<Record<string, string | number>, WorkerRunRow>(
          `SELECT * FROM worker_runs ${filter.where}
           ORDER BY started_at DESC, id DESC LIMIT @limit OFFSET @offset`,
        )
        .all({ ...filter.params, limit: pageSize, offset: (page - 1) * pageSize });

      return { runs: rows.map(toWorkerRun), total, page, pageSize };
    },

    summarizeRuns(query = {}) {
      const conditions: string[] = [];
      const params: Record<string, string> = {};
      if (query.worker !== undefined) {
        conditions.push("worker = @worker");
        params.worker = query.worker;
      }
      if (query.since !== undefined) {
        conditions.push("started_at >= @since");
        params.since = query.since;
      }
      const where = conditions.length === 0 ? "" : `WHERE ${conditions.join(" AND ")}`;

      const rows = db
        .prepare<
          Record<string, string>,
          { outcome: string; count: number; changed: number | null }
        >(
          `SELECT outcome, COUNT(*) AS count, COALESCE(SUM(items_changed), 0) AS changed
           FROM worker_runs ${where} GROUP BY outcome`,
        )
        .all(params);

      let successCount = 0;
      let failedCount = 0;
      let blockedCount = 0;
      let skippedCount = 0;
      let runningCount = 0;
      let itemsChanged = 0;

      for (const row of rows) {
        itemsChanged += row.changed ?? 0;
        switch (row.outcome as RunOutcome) {
          case "success":
            successCount = row.count;
            break;
          case "failed":
            failedCount = row.count;
            break;
          case "blocked":
            blockedCount = row.count;
            break;
          case "skipped":
            skippedCount = row.count;
            break;
          case "running":
            runningCount = row.count;
            break;
        }
      }

      const completedCount = successCount + failedCount + blockedCount;
      const totalRuns = completedCount + skippedCount + runningCount;

      return {
        totalRuns,
        successCount,
        failedCount,
        blockedCount,
        skippedCount,
        runningCount,
        successRate: completedCount > 0 ? successCount / completedCount : null,
        itemsChanged,
      };
    },

    getWorkerStatus(worker, options) {
      const nowIso = options?.now ?? new Date().toISOString();
      const config = options?.config ?? loadCollectorConfig();
      const expectedIntervalMs =
        worker === "collector" ? config.intervalMs : config.analysis.intervalMs;
      const staleThresholdMs = expectedIntervalMs * config.observability.staleAfterIntervals;

      const lastRunRow = selectLastRun.get({ worker });
      if (!lastRunRow) {
        return { state: "stale", lastSuccessAt: null, lastRun: null };
      }
      const lastRun = toWorkerRun(lastRunRow);

      const lastSuccessRow = selectLastSuccess.get({ worker });
      const lastSuccessAt = lastSuccessRow?.finished_at ?? null;

      // design.md D5 2번: "마지막 성공(또는 마지막 기록)이 기대 주기 × N보다 오래됨".
      // 성공 기록이 있으면 그 시각만 본다(그 뒤로 실패·건너뜀이 더 최근이어도 무관) —
      // 성공이 아예 없으면 마지막 기록(오래된 running 고아 포함)의 시작 시각을 본다.
      const referenceIso = lastSuccessAt ?? lastRunRow.started_at;
      const ageMs = new Date(nowIso).getTime() - new Date(referenceIso).getTime();
      if (ageMs > staleThresholdMs) {
        return { state: "stale", lastSuccessAt, lastRun };
      }

      const lastCompletedRow = selectLastCompleted.get({ worker });
      let state: WorkerStatusState = "ok";
      if (lastCompletedRow?.outcome === "blocked") state = "blocked";
      else if (lastCompletedRow?.outcome === "failed") state = "failed";

      return { state, lastSuccessAt, lastRun };
    },
  };
}

let defaultWorkerRunsRepository: WorkerRunsRepository | undefined;
let defaultWorkerRunsRepositoryDb: Db | undefined;

/** 기본 싱글턴 연결에 붙은 저장소. */
export function getWorkerRunsRepository(): WorkerRunsRepository {
  const db = getDb();
  if (!defaultWorkerRunsRepository || defaultWorkerRunsRepositoryDb !== db) {
    defaultWorkerRunsRepository = createWorkerRunsRepository(db);
    defaultWorkerRunsRepositoryDb = db;
  }
  return defaultWorkerRunsRepository;
}

export function startRun(
  worker: WorkerKind,
  options?: { now?: IsoDateTime; config?: CollectorConfig },
): number {
  return getWorkerRunsRepository().startRun(worker, options);
}

export function finishRun(
  runId: number,
  input: FinishRunInput,
  options?: { now?: IsoDateTime },
): WorkerRun {
  return getWorkerRunsRepository().finishRun(runId, input, options);
}

export function recordSkippedRun(
  worker: WorkerKind,
  reason: SkipReason,
  options?: { now?: IsoDateTime; config?: CollectorConfig },
): WorkerRun {
  return getWorkerRunsRepository().recordSkippedRun(worker, reason, options);
}

export function listWorkerRuns(query?: WorkerRunQuery): ListWorkerRunsResult {
  return getWorkerRunsRepository().listWorkerRuns(query);
}

export function summarizeRuns(query?: SummarizeRunsQuery): RunsSummary {
  return getWorkerRunsRepository().summarizeRuns(query);
}

export function getWorkerStatus(
  worker: WorkerKind,
  options?: { now?: IsoDateTime; config?: CollectorConfig },
): WorkerStatus {
  return getWorkerRunsRepository().getWorkerStatus(worker, options);
}
