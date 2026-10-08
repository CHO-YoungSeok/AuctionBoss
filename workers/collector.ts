/**
 * 수집 워커 — 상주 프로세스에서 주기적으로 물건을 수집해 DB에 upsert한다.
 *
 * 실행: `npm run collector`
 *
 * 설계 근거 (design.md D4/D6):
 * - OS cron이 아니라 프로세스 안의 `setInterval`을 쓴다. "이전 회차가 아직 안 끝났으면
 *   건너뛴다"는 spec 요구사항을 lock 파일 없이 메모리 플래그 하나로 만족시킬 수 있다.
 * - 로봇탐지/WAF 차단(`SourceBlockedError`)은 재시도해도 풀리지 않는다(NOTES §6.1).
 *   그래서 차단을 만나면 백오프 창(기본 1시간)을 열고 그 동안의 tick을 건너뛴다. 백오프
 *   종료 시각은 `collector_state.backoff_until`에 기록한다 — 재시작해도 유지되고 사진
 *   워커와 공유된다(fix-photo-worker-and-deploy-config design.md D2).
 *   그 외 오류는 해당 회차만 중단하고 다음 주기에 정상 시도한다.
 *
 * 이 파일은 직접 실행될 때만 스케줄러를 띄운다. `startCollector()`를 export하므로
 * 가짜 `AuctionSource`를 주입해 파이프라인만 검증하는 것도 가능하다.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  closeDb,
  extendBackoffUntil,
  getBackoffUntil,
  getRepository,
  finishRun,
  getCollectorState,
  recordSkippedRun,
  setCollectorState,
  startRun,
  COLLECTOR_STATE_KEYS,
} from "@/lib/db";
import type { FinishRunInput } from "@/lib/db";
import {
  DEFAULT_BLOCK_BACKOFF_MS,
  computeLapDurationMs,
  loadCollectorConfig,
  selectRotationCourts,
  type AuctionItemInput,
  type CollectorRunDetail,
  type CollectorScopeConfig,
  type SkipReason,
} from "@/lib/domain";
import {
  CourtAuctionAdapter,
  SourceBlockedError,
  SourceError,
  consoleLogger,
  type AuctionSource,
  type Logger,
} from "@/lib/sources";

export interface CollectorOptions {
  source: AuctionSource;
  /**
   * 설정된 전체 법원 + 회차 예산(design.md D1). 실제로 이번 회차가 수집할 법원은
   * 이 값 전체가 아니라 로테이션(`selectRotationCourts`)이 고른 일부다 — scale-collection-
   * scheduling task 3.1.
   */
  scope: CollectorScopeConfig;
  intervalMs: number;
  /** 차단(`SourceBlockedError`) 후 tick을 건너뛸 시간(ms). */
  blockBackoffMs?: number;
  logger?: Logger;
  /** 저장 함수. 기본은 실제 저장소. 테스트/검증에서 교체할 수 있다. */
  upsert?: (items: AuctionItemInput[]) => { inserted: number; updated: number; changed: number };
  /** 시작하자마자 1회 실행할지. 기본 true (design.md D4). */
  runImmediately?: boolean;
}

export interface CollectorHandle {
  /** 진행 중인 회차가 끝나기를 기다린 뒤 타이머를 멈춘다. */
  stop(): Promise<void>;
  /** 테스트/검증에서 tick을 직접 밀어 넣기 위한 것. */
  tick(): Promise<void>;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * 회차 기록 호출은 전부 이 세 helper를 거친다(design.md D4, 스펙 MUST NOT).
 * 기록은 부가 기능이라, 저장 실패가 수집 자체를 막아서는 안 된다 — 로그만 남기고 계속
 * 진행한다. D2 때문에 회차마다 시작·종료 두 번 쓰기가 일어나므로 실패 표면도 두 배다.
 */
function safeStartRun(logger: Logger): number | null {
  try {
    return startRun("collector");
  } catch (error) {
    logger.error("[collector] 회차 시작 기록 실패 — 수집은 계속 진행합니다", error);
    return null;
  }
}

/**
 * `runId`가 null이면(시작 기록 자체가 실패했으면) 종료 기록을 시도하지 않는다 — 갱신할
 * 대상 행이 없다. 이 경우 그 회차는 관측되지 않은 채로 지나가지만(기록 실패가 이미
 * 로그로 남았다), 억지로 새 행을 만들면 시작 시각이 실제와 달라 D2의 전제(시작 시
 * 행 생성)가 깨진다.
 */
function safeFinishRun(logger: Logger, runId: number | null, input: FinishRunInput): void {
  if (runId === null) return;
  try {
    finishRun(runId, input);
  } catch (error) {
    // design.md D4 주의: 여기서 삼키면 이 회차는 영원히 'running'으로 남는다 —
    // 의도된 결과다(getWorkerStatus가 오래된 running을 stale로 판정한다).
    logger.error("[collector] 회차 종료 기록 실패 — 수집 결과에는 영향 없음", error);
  }
}

function safeRecordSkippedRun(logger: Logger, reason: SkipReason): void {
  try {
    recordSkippedRun("collector", reason);
  } catch (error) {
    logger.error("[collector] 건너뜀 회차 기록 실패", error);
  }
}

/**
 * 로테이션 위치 조회(design.md D2). 실패하면(예: DB 다운) null을 돌려준다 — 저장된
 * 코드를 못 찾았을 때와 같은 자가 복구 경로(처음부터 다시 시작)를 그대로 타므로,
 * 별도의 오류 처리가 필요 없다.
 */
function safeGetRotationState(logger: Logger): string | null {
  try {
    return getCollectorState(COLLECTOR_STATE_KEYS.ROTATION_NEXT_COURT_CODE);
  } catch (error) {
    logger.error(
      "[collector] 로테이션 위치 조회 실패 — 처음(첫 법원)부터 다시 시작합니다(자가 복구)",
      error,
    );
    return null;
  }
}

/**
 * 로테이션 위치 저장. 실패해도 수집 자체를 막지 않는다(safeStartRun/safeFinishRun과 같은
 * 원칙) — 다음 회차가 이번과 같은 법원부터 다시 시도하는 것으로 저절로 복구된다.
 */
function safeSetRotationState(logger: Logger, courtCode: string): void {
  try {
    setCollectorState(COLLECTOR_STATE_KEYS.ROTATION_NEXT_COURT_CODE, courtCode);
  } catch (error) {
    logger.error(
      "[collector] 로테이션 위치 저장 실패 — 다음 회차는 이번과 같은 법원부터 다시 시도합니다",
      error,
    );
  }
}

/**
 * 공유 백오프 종료 시각 조회(design.md D2). 읽기가 실패하면(예: DB 오류) 백오프 없음으로
 * 진행한다 — DB가 죽었다면 회차 기록도 실패하므로 백오프만 지켜 얻는 것이 없다.
 */
function safeGetBackoffUntil(logger: Logger): Date | null {
  try {
    return getBackoffUntil();
  } catch (error) {
    logger.error("[collector] 백오프 조회 실패 — 백오프 없음으로 보고 진행합니다", error);
    return null;
  }
}

function safeExtendBackoffUntil(logger: Logger, until: Date): void {
  try {
    extendBackoffUntil(until);
  } catch (error) {
    logger.error("[collector] 백오프 기록 실패 — 다음 회차에 차단이 다시 감지될 수 있습니다", error);
  }
}

/**
 * 스케줄러를 시작한다.
 *
 * `running` 플래그는 이 함수의 클로저에 있다. 한 프로세스에서 워커는 하나만 뜨므로
 * 사실상 모듈 수준 플래그와 같고, 검증 스크립트가 여러 인스턴스를 만들 때 서로
 * 간섭하지 않는 장점이 있다.
 */
export function startCollector(options: CollectorOptions): CollectorHandle {
  const logger = options.logger ?? consoleLogger;
  const blockBackoffMs = options.blockBackoffMs ?? DEFAULT_BLOCK_BACKOFF_MS;
  const upsert = options.upsert ?? ((items) => getRepository().upsertItems(items));

  let running = false;
  let runSeq = 0;
  let current: Promise<void> | null = null;

  async function runOnce(): Promise<void> {
    const seq = (runSeq += 1);
    const startedAt = Date.now();

    // 로테이션(design.md D2/D3): 저장된 위치(없거나 목록에 없으면 처음부터, 자가 복구)에서
    // maxCourtsPerRun개를 원형으로 고른다. `fullBatchNextStart`는 "이 배치 전체가 문제없이
    // 끝났을 때" 다음 회차가 시작할 위치이고, 아래에서 배치가 도중에 멈추면(요청 수 안전장치
    // 또는 실패/차단) 그 멈춘 지점으로 덮어쓴다 — 이미 성공한 법원을 다시 돌지 않으면서도
    // 시작하지 못한/실패한 법원은 건너뛰지 않는다.
    const storedCourtCode = safeGetRotationState(logger);
    const { selectedCourts, nextStartCourtCode: fullBatchNextStart } = selectRotationCourts(
      options.scope.courts,
      storedCourtCode,
      options.scope.maxCourtsPerRun,
    );
    let nextStart = fullBatchNextStart;

    const courtsLabel = selectedCourts
      .map((c) => `${c.name}(${c.courtCode || "코드 미지정"})`)
      .join(", ");
    logger.info(`[collector] #${seq} 수집 시작 — 로테이션 대상: ${courtsLabel}`);

    const runId = safeStartRun(logger);
    // 실패해도(예: 소스가 throw만 하고 items를 못 준 경우) 지금까지 확인된 수치만이라도
    // detail에 남긴다 — 부분 정보가 없는 것보다 낫다. pagesRequested의 기본값 0은 "검색
    // 요청을 한 번도 보내기 전에 실패했다"는 뜻이다(예: 세션 부트스트랩 실패) — 검색
    // 요청을 보낸 뒤에 실패했다면(차단 포함) 아래 catch에서 어댑터가 오류에 실어 보낸
    // 실제 값으로 덮어쓴다. 어느 경우든 설정된 페이지 상한 같은 상수로 채우지 않는다 —
    // 그러면 "실제로 몇 페이지를 요청했는지"를 답할 수 없어 이 change의 목적(design.md
    // D1)을 무너뜨린다.
    //
    // targetCourts는 이번 회차가 **실제로 처리(시도)한** 법원만 담는다(design.md D1/D3,
    // scale-collection-scheduling task 3.2) — 로테이션이 후보로 고른 법원 전체가 아니라,
    // 아래 루프에서 실제로 fetchActiveItems를 호출한 법원만 push된다.
    const detail: CollectorRunDetail = {
      targetCourts: [],
      pagesRequested: 0,
      itemsFetched: 0,
      inserted: 0,
      updated: 0,
      changed: 0,
    };
    const allItems: AuctionItemInput[] = [];

    try {
      for (const [index, court] of selectedCourts.entries()) {
        // maxRequestsPerRun 안전장치(design.md D1, task 3.5): 이미 시작한 법원은 절대
        // 끊지 않는다(index 0은 예산과 무관하게 항상 시도) — 법원을 중간에 끊으면 그
        // 법원이 "물건이 줄었다"로 오해된다. 넘으면 **다음** 법원을 아예 시작하지 않는다.
        if (index > 0 && detail.pagesRequested >= options.scope.maxRequestsPerRun) {
          logger.warn(
            `[collector] #${seq} 요청 수 안전장치(${options.scope.maxRequestsPerRun}) 도달 — ` +
              `${court.name}부터는 이번 회차에서 시작하지 않습니다(다음 회차에 이어서 시도)`,
          );
          nextStart = court.courtCode;
          break;
        }

        try {
          // 법원 하나씩 개별 호출한다(design.md D1) — 회차 전체를 한 번에 넘기면 위
          // 안전장치가 "요청을 보내 보기 전까지는 알 수 없는" 페이지 수를 법원 사이에서
          // 확인할 지점이 없다.
          const { items, pagesRequested } = await options.source.fetchActiveItems({
            courts: [court],
          });
          detail.targetCourts.push(court.name);
          detail.pagesRequested += pagesRequested;
          detail.itemsFetched += items.length;
          allItems.push(...items);
        } catch (error) {
          detail.targetCourts.push(court.name);
          if (error instanceof SourceError && typeof error.pagesRequested === "number") {
            detail.pagesRequested += error.pagesRequested;
          }
          // 차단이든 일반 실패든, 이 법원은 끝까지 수집되지 못했다 — 다음 회차는 (다른
          // 법원으로 건너뛰지 않고) 바로 이 법원부터 다시 시도한다(design.md D4, task 3.3).
          // 차단의 경우 이 값이 곧 "로테이션 위치를 전진시키지 않는다"는 요구를 만족시킨다
          // — 저장된 값이 이번 회차 시작 시점과 동일한 법원을 가리키게 되기 때문이다.
          // 같은 회차에서 다음 법원으로 넘어가지 않는 것(task 3.4)은 이 예외가 바깥
          // for 루프를 즉시 벗어나게(그리고 아래에서 다시 던져) 자연히 보장된다.
          nextStart = court.courtCode;
          throw error;
        }
      }

      logger.info(`[collector] #${seq} 수집된 물건 ${allItems.length}건`);

      // `changed`(감시 필드가 실제로 바뀐 물건 수)를 로그에 남긴다(코드 리뷰 finding 4) —
      // auction-collection 스펙이 요구하는 값일 뿐 아니라, finding 3의 재분석 유발 패턴
      // (감시 필드가 회차마다 뒤집히는 물건)이 실제로 일어나고 있는지 운영자가 알아챌 수
      // 있는 유일한 신호다. 이전에는 이 값이 upsert()가 계산해도 조용히 버려졌다.
      const { inserted, updated, changed } = upsert(allItems);
      detail.inserted = inserted;
      detail.updated = updated;
      detail.changed = changed;
      logger.info(
        `[collector] #${seq} 저장 완료 — inserted=${inserted}, updated=${updated}, changed=${changed}, ` +
          `소요 ${formatDuration(Date.now() - startedAt)}`,
      );
      safeFinishRun(logger, runId, { outcome: "success", detail });
      safeSetRotationState(logger, nextStart);
    } catch (error) {
      // 어댑터의 오류 타입 이름을 그대로 error_kind로 쓴다(design.md D1) — 새 판정 로직이
      // 필요 없다. RobotDetectedError/WafBlockedError(SourceBlockedError의 하위)는 blocked,
      // 그 외(ResponseSchemaError, SourceRequestError, 예상 못한 오류)는 failed.
      const errorKind = error instanceof Error ? error.name : String(error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      safeFinishRun(logger, runId, {
        outcome: error instanceof SourceBlockedError ? "blocked" : "failed",
        errorKind,
        errorMessage,
        detail,
      });
      safeSetRotationState(logger, nextStart);
      // 기록 후 그대로 다시 던진다 — tick()의 catch가 차단 백오프 여부를 그대로
      // 판단해야 하므로 여기서 오류를 삼키지 않는다(기존 제어 흐름 변경 없음).
      throw error;
    }
  }

  async function tick(): Promise<void> {
    // spec: 이전 수집이 아직 실행 중이면 새 수집을 시작하지 않고 건너뛴다.
    if (running) {
      logger.warn("[collector] 이전 회차가 아직 실행 중이라 이번 주기를 건너뜁니다");
      safeRecordSkippedRun(logger, "overlap");
      return;
    }
    // 백오프는 프로세스 메모리가 아니라 공유 저장소에서 읽는다 — 재시작 후에도, 다른
    // 워커(사진)가 기록한 백오프도 지켜야 한다.
    const backoffUntil = safeGetBackoffUntil(logger);
    const remaining = backoffUntil ? backoffUntil.getTime() - Date.now() : 0;
    if (remaining > 0) {
      logger.warn(
        `[collector] 소스 차단 백오프 중이라 건너뜁니다 — 남은 시간 ${formatDuration(remaining)}`,
      );
      safeRecordSkippedRun(logger, "backoff");
      return;
    }

    running = true;
    const done = (async () => {
      try {
        await runOnce();
      } catch (error) {
        if (error instanceof SourceBlockedError) {
          safeExtendBackoffUntil(logger, new Date(Date.now() + blockBackoffMs));
          logger.error(
            `[collector] 소스가 접근을 차단했습니다 (${error.name}). ` +
              `${formatDuration(blockBackoffMs)} 동안 수집을 멈춥니다.`,
            error,
          );
        } else {
          // 조용히 삼키지 않는다 — 원인을 남기고 이번 회차만 중단, 다음 주기는 정상 시도.
          logger.error("[collector] 수집 회차가 실패했습니다 (다음 주기에 다시 시도합니다)", error);
        }
      } finally {
        running = false;
      }
    })();
    current = done;
    await done;
  }

  const timer = setInterval(() => {
    void tick();
  }, options.intervalMs);
  // 타이머가 이벤트 루프를 붙잡아 프로세스가 안 죽는 것은 의도된 동작(상주 워커).

  if (options.runImmediately !== false) void tick();

  return {
    tick,
    async stop() {
      clearInterval(timer);
      if (current) await current.catch(() => {});
    },
  };
}

// ------------------------------------------------------------------ 엔트리포인트

/** 숫자형 환경변수 오버라이드. 로컬 검증에서 config를 고치지 않아도 되게 한다. */
function envInt(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name}은(는) 양의 정수여야 합니다: "${raw}"`);
  }
  return Math.trunc(parsed);
}

export function main(): CollectorHandle {
  const config = loadCollectorConfig();
  const intervalMs = envInt("AUCTIONBOSS_COLLECT_INTERVAL_MS") ?? config.intervalMs;
  const blockBackoffMs = envInt("AUCTIONBOSS_COLLECT_BACKOFF_MS") ?? DEFAULT_BLOCK_BACKOFF_MS;
  const pageSize = envInt("AUCTIONBOSS_COLLECT_PAGE_SIZE");
  const pageDelayMs = envInt("AUCTIONBOSS_COLLECT_PAGE_DELAY_MS");
  const bidWindowDays = envInt("AUCTIONBOSS_COLLECT_BID_WINDOW_DAYS");
  const maxPages = envInt("AUCTIONBOSS_COLLECT_MAX_PAGES");

  const source = new CourtAuctionAdapter({
    pageSize,
    pageDelayMs,
    bidWindowDays,
    maxPages,
    logger: consoleLogger,
  });

  const lapMs = computeLapDurationMs(
    config.scope.courts.length,
    config.scope.maxCourtsPerRun,
    intervalMs,
  );
  console.log(
    `[collector] 시작 — 주기 ${intervalMs}ms, 차단 백오프 ${blockBackoffMs}ms, ` +
      `대상 ${config.scope.courts.length}곳(회차당 ${config.scope.maxCourtsPerRun}곳, ` +
      `한 바퀴 약 ${formatDuration(lapMs)})`,
  );

  const handle = startCollector({
    source,
    scope: config.scope,
    intervalMs,
    blockBackoffMs,
  });

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[collector] ${signal} 수신 — 진행 중인 회차를 마치고 종료합니다`);
    void handle.stop().then(() => {
      closeDb();
      process.exit(0);
    });
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  return handle;
}

/** `tsx workers/collector.ts`로 직접 실행됐을 때만 상주 스케줄러를 띄운다. */
const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) {
  main();
}
