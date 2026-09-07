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

import { closeDb, getRepository } from "@/lib/db";
import { loadCollectorConfig, type AuctionItemInput, type CollectScope } from "@/lib/domain";
import {
  CourtAuctionAdapter,
  SourceBlockedError,
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

    const items = await options.source.fetchActiveItems(options.scope);
    logger.info(`[collector] #${seq} 수집된 물건 ${items.length}건`);

    // `changed`(감시 필드가 실제로 바뀐 물건 수)를 로그에 남긴다(코드 리뷰 finding 4) —
    // auction-collection 스펙이 요구하는 값일 뿐 아니라, finding 3의 재분석 유발 패턴
    // (감시 필드가 회차마다 뒤집히는 물건)이 실제로 일어나고 있는지 운영자가 알아챌 수
    // 있는 유일한 신호다. 이전에는 이 값이 upsert()가 계산해도 조용히 버려졌다.
    const { inserted, updated, changed } = upsert(items);
    logger.info(
      `[collector] #${seq} 저장 완료 — inserted=${inserted}, updated=${updated}, changed=${changed}, ` +
        `소요 ${formatDuration(Date.now() - startedAt)}`,
    );
  }

  async function tick(): Promise<void> {
    // spec: 이전 수집이 아직 실행 중이면 새 수집을 시작하지 않고 건너뛴다.
    if (running) {
      logger.warn("[collector] 이전 회차가 아직 실행 중이라 이번 주기를 건너뜁니다");
      return;
    }
    const remaining = blockedUntil - Date.now();
    if (remaining > 0) {
      logger.warn(
        `[collector] 소스 차단 백오프 중이라 건너뜁니다 — 남은 시간 ${formatDuration(remaining)}`,
      );
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
