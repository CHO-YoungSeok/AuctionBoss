/**
 * 수집 워커 — 상주 프로세스에서 주기적으로 물건을 수집해 DB에 upsert한다.
 *
 * 실행: `npm run collector`
 *
 * 설계 근거 (design.md D4/D6):
 * - OS cron이 아니라 프로세스 안의 `setInterval`을 쓴다. "이전 회차가 아직 안 끝났으면
 *   건너뛴다"는 spec 요구사항을 lock 파일 없이 메모리 플래그 하나로 만족시킬 수 있다.
 * - 로봇탐지/WAF 차단(`SourceBlockedError`)은 재시도해도 풀리지 않는다(NOTES §6.1).
 *   그래서 차단을 만나면 백오프 창(기본 1시간)을 열고 그 동안의 tick을 건너뛴다.
 *   그 외 오류는 해당 회차만 중단하고 다음 주기에 정상 시도한다.
 *
 * 이 파일은 직접 실행될 때만 스케줄러를 띄운다. `startCollector()`를 export하므로
 * 가짜 `AuctionSource`를 주입해 파이프라인만 검증하는 것도 가능하다.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import { closeDb, getRepository, finishRun, recordSkippedRun, startRun } from "@/lib/db";
import type { FinishRunInput } from "@/lib/db";
import {
  loadCollectorConfig,
  type AuctionItemInput,
  type CollectScope,
  type CollectorRunDetail,
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

/** 차단 감지 시 기본 백오프. NOTES §6.1이 "최소 1시간 권장"이라 적었다. */
export const DEFAULT_BLOCK_BACKOFF_MS = 60 * 60 * 1000;

export interface CollectorOptions {
  source: AuctionSource;
  scope: CollectScope;
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
  let blockedUntil = 0;
  let runSeq = 0;
  let current: Promise<void> | null = null;

  async function runOnce(): Promise<void> {
    const seq = (runSeq += 1);
    const startedAt = Date.now();
    const courts = options.scope.courts.map((c) => `${c.name}(${c.courtCode || "코드 미지정"})`);
    logger.info(`[collector] #${seq} 수집 시작 — 대상: ${courts.join(", ")}`);

    const runId = safeStartRun(logger);
    // 실패해도(예: 소스가 throw만 하고 items를 못 준 경우) 지금까지 확인된 수치만이라도
    // detail에 남긴다 — 부분 정보가 없는 것보다 낫다. pagesRequested의 기본값 0은 "검색
    // 요청을 한 번도 보내기 전에 실패했다"는 뜻이다(예: 세션 부트스트랩 실패) — 검색
    // 요청을 보낸 뒤에 실패했다면(차단 포함) 아래 catch에서 어댑터가 오류에 실어 보낸
    // 실제 값으로 덮어쓴다. 어느 경우든 설정된 페이지 상한 같은 상수로 채우지 않는다 —
    // 그러면 "실제로 몇 페이지를 요청했는지"를 답할 수 없어 이 change의 목적(design.md
    // D1)을 무너뜨린다.
    const detail: CollectorRunDetail = {
      targetCourts: options.scope.courts.map((c) => c.name),
      pagesRequested: 0,
      itemsFetched: 0,
      inserted: 0,
      updated: 0,
      changed: 0,
    };

    try {
      const { items, pagesRequested } = await options.source.fetchActiveItems(options.scope);
      detail.pagesRequested = pagesRequested;
      detail.itemsFetched = items.length;
      logger.info(`[collector] #${seq} 수집된 물건 ${items.length}건`);

      // `changed`(감시 필드가 실제로 바뀐 물건 수)를 로그에 남긴다(코드 리뷰 finding 4) —
      // auction-collection 스펙이 요구하는 값일 뿐 아니라, finding 3의 재분석 유발 패턴
      // (감시 필드가 회차마다 뒤집히는 물건)이 실제로 일어나고 있는지 운영자가 알아챌 수
      // 있는 유일한 신호다. 이전에는 이 값이 upsert()가 계산해도 조용히 버려졌다.
      const { inserted, updated, changed } = upsert(items);
      detail.inserted = inserted;
      detail.updated = updated;
      detail.changed = changed;
      logger.info(
        `[collector] #${seq} 저장 완료 — inserted=${inserted}, updated=${updated}, changed=${changed}, ` +
          `소요 ${formatDuration(Date.now() - startedAt)}`,
      );
      safeFinishRun(logger, runId, { outcome: "success", detail });
    } catch (error) {
      // 어댑터의 오류 타입 이름을 그대로 error_kind로 쓴다(design.md D1) — 새 판정 로직이
      // 필요 없다. RobotDetectedError/WafBlockedError(SourceBlockedError의 하위)는 blocked,
      // 그 외(ResponseSchemaError, SourceRequestError, 예상 못한 오류)는 failed.
      const errorKind = error instanceof Error ? error.name : String(error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      // 어댑터가 실패 전까지 실제로 보낸 페이지 수를 오류에 실어 보냈으면(SourceError.
      // pagesRequested) 그 값으로 detail을 덮어쓴다 — 차단·실패 회차야말로 "몇 번
      // 요청했길래 이렇게 됐는지"를 가장 알아야 하고, 0으로 남기면 "요청을 안 보냈다"로
      // 읽혀 사실과 반대가 된다. 값이 없으면(예: 세션 부트스트랩 단계에서 실패해 검색
      // 요청 자체를 한 번도 보내기 전) 기존 기본값 0을 그대로 둔다 — 그 경우는 실제로 0이 맞다.
      if (error instanceof SourceError && typeof error.pagesRequested === "number") {
        detail.pagesRequested = error.pagesRequested;
      }
      safeFinishRun(logger, runId, {
        outcome: error instanceof SourceBlockedError ? "blocked" : "failed",
        errorKind,
        errorMessage,
        detail,
      });
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
    const remaining = blockedUntil - Date.now();
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
          blockedUntil = Date.now() + blockBackoffMs;
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

  console.log(
    `[collector] 시작 — 주기 ${intervalMs}ms, 차단 백오프 ${blockBackoffMs}ms, ` +
      `대상 ${config.scope.courts.length}곳`,
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
