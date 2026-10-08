/**
 * 사진 워커 — 상주 프로세스에서 주기적으로 물건 사진을 수집한다.
 *
 * 실행: `npm run photos` (상주), `npm run photos -- --once` (회차 하나만 처리하고 종료)
 *
 * 설계 근거 (fix-photo-worker-and-deploy-config design.md D1~D4):
 * - 수집 워커와 같은 `setInterval` + `running` 플래그 구조다. 겹침 건너뜀을 lock 파일 없이
 *   메모리 플래그로 해결하고, 같은 방식으로 배포·관측된다.
 * - 소스 접근은 전부 `AuctionSource.fetchItemPhotos` 뒤에 있다. 워커 본체는 소스 구현
 *   모듈을 직접 참조하지 않고 주입받은 소스만 쓴다 — 어댑터는 엔트리포인트(`main`)에서만 만든다.
 * - 차단(`SourceBlockedError`)만 `collector_state.backoff_until`에 기록한다(수집 워커와
 *   공유). 일반 오류로는 백오프를 걸지 않는다. 차단으로 중단된 물건은 `failed`로 기록하지
 *   않는다 — 물건이 아니라 IP의 문제이므로 백오프 뒤 미시도 상태로 다시 시도해야 한다.
 * - 회차는 `worker_runs`에 기록한다. 기록은 부가 기능이라 저장 실패가 사진 저장을 막지
 *   않는다(로그만 남긴다).
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  closeDb,
  extendBackoffUntil,
  finishRun,
  getBackoffUntil,
  getRepository,
  recordSkippedRun,
  startRun,
} from "@/lib/db";
import type { FinishRunInput } from "@/lib/db";
import {
  DEFAULT_BLOCK_BACKOFF_MS,
  loadCollectorConfig,
  type AuctionItem,
  type PhotoStatus,
  type PhotosConfig,
  type PhotosRunDetail,
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
import { saveBase64Photo } from "@/lib/storage/photos";

/** 저장 계층. 기본은 실제 저장소·파일 저장. 테스트에서 가짜를 넣는다. */
export interface PhotoStore {
  getPendingItems(
    limit: number,
    options: { now: Date; retryAfterHours: number },
  ): AuctionItem[];
  /** 사진 파일을 저장하고 메타데이터를 돌려준다. */
  saveFile(
    itemId: number,
    seq: number,
    base64: string,
  ): { filePath: string; fileSize: number; mimeType: string };
  saveCollected(
    itemId: number,
    photos: Array<{ seq: number; filePath: string; fileSize: number; mimeType: string }>,
    now: Date,
  ): void;
  markStatus(itemId: number, status: PhotoStatus, now: Date): void;
}

export const defaultPhotoStore: PhotoStore = {
  getPendingItems: (limit, options) => getRepository().getPendingPhotoItems(limit, options),
  saveFile: (itemId, seq, base64) => saveBase64Photo(itemId, seq, base64),
  saveCollected: (itemId, photos, now) =>
    getRepository().saveItemPhotos(itemId, photos, "collected", { now: now.toISOString() }),
  markStatus: (itemId, status, now) =>
    getRepository().updateItemPhotoStatus(itemId, status, { now: now.toISOString() }),
};

export interface PhotoWorkerOptions {
  /** 회차마다 새 소스(세션)를 만든다 — 세션 수명을 회차 하나로 묶는다(design.md D1). */
  createSource: () => AuctionSource;
  config: PhotosConfig;
  /** 차단 후 백오프 길이(ms). 기본 1시간(수집 워커와 같은 값). */
  blockBackoffMs?: number;
  logger?: Logger;
  store?: PhotoStore;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  /** 시작하자마자 1회 실행할지. 기본 true. */
  runImmediately?: boolean;
}

/** `tick()`의 결과. 건너뛴 주기는 "skipped"다. */
export type PhotoTickResult = "success" | "failed" | "blocked" | "skipped";

export interface PhotoWorkerHandle {
  /** 진행 중인 회차가 끝나기를 기다린 뒤 타이머를 멈춘다. */
  stop(): Promise<void>;
  /** 회차 하나를 실행한다(테스트·`--once`용). */
  tick(): Promise<PhotoTickResult>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function describeError(error: unknown): { kind: string; message: string } {
  if (error instanceof Error) return { kind: error.name, message: error.message };
  return { kind: "Error", message: String(error) };
}

export function startPhotoWorker(options: PhotoWorkerOptions): PhotoWorkerHandle {
  const logger = options.logger ?? consoleLogger;
  const store = options.store ?? defaultPhotoStore;
  const now = options.now ?? (() => new Date());
  const sleep = options.sleep ?? defaultSleep;
  const blockBackoffMs = options.blockBackoffMs ?? DEFAULT_BLOCK_BACKOFF_MS;
  const { config } = options;

  let running = false;
  let current: Promise<unknown> | null = null;

  // ---- 회차 기록 helper: 기록 실패는 사진 수집을 막지 않는다 ----

  function safeStartRun(): number | null {
    try {
      return startRun("photos");
    } catch (error) {
      logger.error("[photos] 회차 시작 기록 실패 — 수집은 계속 진행합니다", error);
      return null;
    }
  }

  function safeFinishRun(runId: number | null, input: FinishRunInput): void {
    if (runId === null) return;
    try {
      finishRun(runId, input);
    } catch (error) {
      logger.error("[photos] 회차 종료 기록 실패 — 수집 결과에는 영향 없음", error);
    }
  }

  function safeRecordSkippedRun(reason: SkipReason): void {
    try {
      recordSkippedRun("photos", reason);
    } catch (error) {
      logger.error("[photos] 건너뜀 회차 기록 실패", error);
    }
  }

  /** 읽기 실패는 백오프 없음으로 보고 진행한다(collector와 같은 원칙). */
  function readBackoffRemainingMs(): number {
    try {
      const until = getBackoffUntil();
      return until ? until.getTime() - now().getTime() : 0;
    } catch (error) {
      logger.error("[photos] 백오프 조회 실패 — 백오프 없음으로 보고 진행합니다", error);
      return 0;
    }
  }

  function safeExtendBackoff(until: Date): void {
    try {
      extendBackoffUntil(until);
    } catch (error) {
      logger.error("[photos] 백오프 기록 실패 — 다음 회차에 차단이 다시 감지될 수 있습니다", error);
    }
  }

  // ---- 회차 본체 ----

  async function runRound(): Promise<Exclude<PhotoTickResult, "skipped">> {
    const runId = safeStartRun();
    const detail: PhotosRunDetail = {
      attempted: 0,
      collected: 0,
      empty: 0,
      failed: 0,
      requestsMade: 0,
    };
    let blocked = false;
    let lastError: { kind: string; message: string } | null = null;

    try {
      const items = store.getPendingItems(config.maxItemsPerRun, {
        now: now(),
        retryAfterHours: config.retryAfterHours,
      });
      logger.info(`[photos] 수집 시작 — 대기 물건 ${items.length}건`);

      if (items.length > 0) {
        const source = options.createSource();

        for (const [index, item] of items.entries()) {
          if (index > 0) await sleep(config.requestDelayMs);

          // 수집 워커가 회차 도중 차단을 기록했을 수 있다 — 요청 직전에 다시 확인한다.
          const remaining = readBackoffRemainingMs();
          if (remaining > 0) {
            logger.warn(
              `[photos] 다른 워커가 차단 백오프를 기록했습니다 — 남은 ${items.length - index}건은 ` +
                `이번 회차에서 요청하지 않습니다 (남은 시간 ${Math.round(remaining / 1000)}s)`,
            );
            break;
          }

          if (!item.internalCaseNo || !item.courtCode) continue; // 조회 불가 — 요청도 실패 기록도 하지 않는다

          detail.attempted += 1;
          try {
            const result = await source.fetchItemPhotos({
              courtCode: item.courtCode,
              internalCaseNo: item.internalCaseNo,
            });
            detail.requestsMade += result.requestsMade;

            const saved = result.photos.map((photo) => ({
              seq: photo.seq,
              ...store.saveFile(item.id, photo.seq, photo.base64),
            }));
            if (saved.length > 0) {
              store.saveCollected(item.id, saved, now());
              detail.collected += 1;
            } else {
              store.markStatus(item.id, "empty", now());
              detail.empty += 1;
            }
          } catch (error) {
            if (error instanceof SourceError && typeof error.pagesRequested === "number") {
              detail.requestsMade += error.pagesRequested;
            }
            lastError = describeError(error);

            if (error instanceof SourceBlockedError) {
              // 차단은 물건의 문제가 아니라 IP의 문제 — 물건을 failed로 기록하지 않고
              // 공유 백오프를 걸고 회차를 끝낸다.
              safeExtendBackoff(new Date(now().getTime() + blockBackoffMs));
              logger.error(
                `[photos] 소스가 접근을 차단했습니다 (${error.name}). ` +
                  `${Math.round(blockBackoffMs / 1000)}s 동안 사진 수집을 멈춥니다.`,
                error,
              );
              blocked = true;
              break;
            }

            logger.error(`[photos] 물건 ${item.id} 사진 수집 실패 (다음 물건으로 넘어갑니다)`, error);
            detail.failed += 1;
            try {
              store.markStatus(item.id, "failed", now());
            } catch (markError) {
              logger.error(`[photos] 물건 ${item.id} 실패 상태 기록 실패`, markError);
            }
          }
        }
      }
    } catch (error) {
      // 대기 물건 조회 실패 등 회차 전체를 못 돌린 경우
      lastError = describeError(error);
      logger.error("[photos] 사진 회차가 실패했습니다 (다음 주기에 다시 시도합니다)", error);
      safeFinishRun(runId, {
        outcome: "failed",
        errorKind: lastError.kind,
        errorMessage: lastError.message,
        detail,
      });
      return "failed";
    }

    // 결과 규칙(spec "사진 워커 회차 기록"): 차단 > 전부 실패 > 성공.
    // 일부만 실패한 회차는 성공이다 — 물건 단위 실패는 재시도 간격으로 따로 관리된다.
    if (blocked) {
      safeFinishRun(runId, {
        outcome: "blocked",
        errorKind: lastError?.kind ?? null,
        errorMessage: lastError?.message ?? null,
        detail,
      });
      return "blocked";
    }
    if (detail.attempted > 0 && detail.failed === detail.attempted) {
      safeFinishRun(runId, {
        outcome: "failed",
        errorKind: lastError?.kind ?? null,
        errorMessage: lastError?.message ?? null,
        detail,
      });
      return "failed";
    }
    logger.info(
      `[photos] 회차 완료 — 시도 ${detail.attempted}, 저장 ${detail.collected}, ` +
        `사진 없음 ${detail.empty}, 실패 ${detail.failed}, 요청 ${detail.requestsMade}`,
    );
    safeFinishRun(runId, { outcome: "success", detail });
    return "success";
  }

  async function tick(): Promise<PhotoTickResult> {
    if (running) {
      logger.warn("[photos] 이전 회차가 아직 실행 중이라 이번 주기를 건너뜁니다");
      safeRecordSkippedRun("overlap");
      return "skipped";
    }
    const remaining = readBackoffRemainingMs();
    if (remaining > 0) {
      logger.warn(
        `[photos] 소스 차단 백오프 중이라 건너뜁니다 — 남은 시간 ${Math.round(remaining / 1000)}s`,
      );
      safeRecordSkippedRun("backoff");
      return "skipped";
    }

    running = true;
    const done = runRound().finally(() => {
      running = false;
    });
    current = done;
    return done;
  }

  const timer = setInterval(() => {
    void tick();
  }, config.intervalMs);

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

/** 양의 정수 환경변수 오버라이드. 없으면 undefined, 잘못된 값이면 즉시 throw. */
function envInt(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name}은(는) 양의 정수여야 합니다: "${raw}"`);
  }
  return Math.trunc(parsed);
}

/** 설정 파일의 photos 절에 환경변수 오버라이드를 얹는다. */
export function resolvePhotosConfig(base: PhotosConfig): PhotosConfig {
  return {
    intervalMs: envInt("AUCTIONBOSS_PHOTOS_INTERVAL_MS") ?? base.intervalMs,
    maxItemsPerRun: envInt("AUCTIONBOSS_PHOTOS_MAX_ITEMS") ?? base.maxItemsPerRun,
    requestDelayMs: envInt("AUCTIONBOSS_PHOTOS_REQUEST_DELAY_MS") ?? base.requestDelayMs,
    retryAfterHours: envInt("AUCTIONBOSS_PHOTOS_RETRY_AFTER_HOURS") ?? base.retryAfterHours,
  };
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const once = argv.includes("--once");
  const config = resolvePhotosConfig(loadCollectorConfig().photos);
  // 차단은 IP 단위라 수집 워커와 같은 변수·같은 기본값을 쓴다(design.md D2).
  const blockBackoffMs = envInt("AUCTIONBOSS_COLLECT_BACKOFF_MS") ?? DEFAULT_BLOCK_BACKOFF_MS;
  const createSource = () => new CourtAuctionAdapter({ logger: consoleLogger });

  console.log(
    `[photos] 시작 — ${once ? "1회 실행" : `주기 ${config.intervalMs}ms`}, ` +
      `회차당 최대 ${config.maxItemsPerRun}건, 요청 간격 ${config.requestDelayMs}ms, ` +
      `실패 재시도 ${config.retryAfterHours}시간, 차단 백오프 ${blockBackoffMs}ms`,
  );

  const handle = startPhotoWorker({
    createSource,
    config,
    blockBackoffMs,
    runImmediately: false,
  });

  if (once) {
    const result = await handle.tick();
    await handle.stop();
    closeDb();
    process.exitCode = result === "failed" || result === "blocked" ? 1 : 0;
    return;
  }

  void handle.tick();

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[photos] ${signal} 수신 — 진행 중인 회차를 마치고 종료합니다`);
    void handle.stop().then(() => {
      closeDb();
      process.exit(0);
    });
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

/** `tsx workers/photos.ts`로 직접 실행됐을 때만 워커를 띄운다. */
const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) {
  void main().catch((error: unknown) => {
    console.error("[photos] 치명적 오류", error);
    process.exit(1);
  });
}
