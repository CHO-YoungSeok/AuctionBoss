/**
 * 분석 워커 (auction-analysis).
 *
 * 한 회차는 두 단계로 대상을 고른다(design.md D4/D5):
 *   1. `GET /api/items?analyzed=false&pageSize=<신규 한도>` — 신규 분석
 *   2. `GET /api/items?needsAnalysis=true&promptVersion=<현재 버전>&pageSize=<재분석 한도>`
 *      — 재분석. 1단계에서 이미 고른 물건은 제외한다.
 * 이후 물건마다 프롬프트 렌더 → `claude -p --output-format json` 실행 → 결과 파싱 →
 * `POST /api/analyses`.
 *
 * 신규가 항상 먼저 배정된다 — 재분석 대기열이 아직 한 번도 분석되지 않은 물건을
 * 무한히 미루면 안 된다는 스펙 요구를 두 번 조회하는 구조 자체로 명백하게 만든다.
 *
 * 원칙:
 * - DB를 직접 열지 않는다. 서버와는 HTTP로만 통신한다 (design.md D5).
 * - 물건 하나의 실패가 회차를 중단시키지 않는다 (spec "개별 분석 실패"). 실패는
 *   물건 식별자와 사유를 함께 로그로 남기고 다음 물건으로 넘어간다.
 * - Claude 호출은 순차적으로 한다. 병렬로 돌리면 회차당 비용 상한을 지키더라도
 *   순간 부하와 rate limit을 감당하기 어렵다.
 *
 * 실행:
 *   npm run analyzer            # 상주(즉시 1회 + 주기 실행)
 *   npm run analyzer -- --once  # 1회만 실행하고 종료
 */
import { loadCollectorConfig } from "@/lib/domain";
import type { AuctionItem } from "@/lib/domain";

import {
  DEFAULT_API_BASE,
  fetchReanalysisCandidates,
  fetchUnanalyzedItems,
  finishWorkerRun,
  postAnalysis,
  startWorkerRun,
  type FetchFn,
  type FinishWorkerRunInput,
} from "./lib/api";
import { DEFAULT_CLAUDE_TIMEOUT_MS, runClaude as defaultRunClaude, type RunClaude } from "./lib/claude";
import { classifyFailure } from "./lib/classify-failure";
import { FailureCooldown } from "./lib/failure-cooldown";
import { PROMPT_VERSION, loadPromptTemplate, renderItemPrompt } from "./lib/prompt";
import { resolveRunner } from "./lib/runner";

export interface Logger {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
}

const consoleLogger: Logger = {
  info: (message) => console.log(message),
  warn: (message) => console.warn(message),
  error: (message) => console.error(message),
};

/** 회차 결과 요약. 로그와 테스트가 같은 값을 본다. */
export interface AnalysisRunSummary {
  attempted: number;
  succeeded: number;
  failed: number;
}

/** 백엔드 `ItemSearchCondition.MAX_PAGE_SIZE`(GET /api/items의 pageSize 상한)와 같은 값. 쿨다운 여유분을 더해도 이를 넘기지 않는다. */
const BACKEND_MAX_PAGE_SIZE = 200;

export interface AnalysisRunOptions {
  /**
   * 물건별 실패 쿨다운. 회차 사이에 유지돼야 하므로 상주 실행(`startAnalyzer`)이 하나를
   * 만들어 계속 넘긴다. 생략하면 회차마다 새로 만들어 쿨다운이 없는 것과 같다(하위 호환).
   */
  cooldown?: FailureCooldown;
  maxItemsPerRun: number;
  /**
   * 회차당 최대 재분석 건수(design.md D5). 기본값 0 — 재분석 조회 자체를 생략한다.
   * 기존 호출자(테스트 포함)가 이 필드를 몰라도 이전과 똑같이 신규 분석만 도는
   * 하위 호환을 위한 기본값이다. 실제 운용은 `resolveAnalyzerSettings`가 설정 파일의
   * `analysis.maxReanalysisPerRun`을 채워 넣는다.
   */
  maxReanalysisPerRun?: number;
  baseUrl?: string;
  /** 미리 읽어둔 템플릿. 없으면 회차마다 파일에서 읽는다. */
  template?: string;
  promptVersion?: string;
  /** `--model`로 넘길 값. null이면 CLI 기본 모델. */
  model?: string | null;
  timeoutMs?: number;
  /** 주입 지점. 기본값은 실제 CLI 실행 / 전역 fetch. */
  runClaude?: RunClaude;
  fetchFn?: FetchFn;
  logger?: Logger;
}

function describeItem(item: AuctionItem): string {
  return `#${item.id} ${item.court} ${item.caseNo}-${item.itemNo}`;
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    const cause = error.cause instanceof Error ? ` (cause: ${error.cause.message})` : "";
    return `${error.name}: ${error.message}${cause}`;
  }
  return String(error);
}

/**
 * 회차 기록 호출은 전부 이 두 helper를 거친다(design.md D3/D4, 스펙 MUST NOT).
 * 분석 워커는 DB를 직접 쓰지 않으므로 collector와 달리 회차 기록도 네트워크 호출이라
 * 실패 표면이 하나 더 있다(서버 다운, 타임아웃 등) — 그래도 기록 실패가 분석 자체를
 * 막아서는 안 된다.
 */
async function safeStartWorkerRun(baseUrl: string, fetchFn: FetchFn, logger: Logger): Promise<number | null> {
  try {
    return await startWorkerRun({ baseUrl, worker: "analyzer", fetchFn });
  } catch (error) {
    logger.error(`[analyzer] 회차 시작 기록 실패 — 분석은 계속 진행합니다 (${describeError(error)})`);
    return null;
  }
}

/**
 * `runId`가 null이면(시작 기록 자체가 실패했으면) 종료 기록을 시도하지 않는다 — collector의
 * `safeFinishRun`과 같은 이유다: 갱신할 회차 행 자체가 없다.
 */
async function safeFinishWorkerRun(
  baseUrl: string,
  fetchFn: FetchFn,
  logger: Logger,
  runId: number | null,
  input: FinishWorkerRunInput,
): Promise<void> {
  if (runId === null) return;
  try {
    await finishWorkerRun({ baseUrl, runId, input, fetchFn });
  } catch (error) {
    logger.error(`[analyzer] 회차 종료 기록 실패 (${describeError(error)})`);
  }
}

/**
 * 한 회차 실행.
 *
 * 목록 조회 실패는 회차 전체의 실패라 그대로 throw한다(호출자가 로그를 남긴다) — 그
 * 전에 이 회차를 `failed`로 기록한다(design.md D3). 물건 단위 실패는 여기서 잡아 세기만
 * 하고 밖으로 던지지 않는다. 물건 탓(item) 실패는 쿨다운에 넣고 계속하며 회차는 `success`
 * (개별 실패는 `detail.failed`)다. 환경 탓(systemic: 백엔드 다운·인증·한도 등) 실패는 회차를
 * 중단하고 `failed`로 기록한다(쿨다운 없음; 같은 물건이 3회 연속 중단시키면 쿨다운) — 분석할 대상이 전혀 없는 회차도 마찬가지로 `success`/0건으로
 * 기록된다(스펙 "분석할 물건이 없는 회차": 기록 자체가 없으면 죽은 워커와 구별할 수 없다).
 */
export async function runAnalysisOnce(options: AnalysisRunOptions): Promise<AnalysisRunSummary> {
  const {
    maxItemsPerRun,
    maxReanalysisPerRun = 0,
    baseUrl = process.env.AUCTIONBOSS_API_BASE ?? DEFAULT_API_BASE,
    promptVersion = PROMPT_VERSION,
    model = null,
    timeoutMs = DEFAULT_CLAUDE_TIMEOUT_MS,
    runClaude = defaultRunClaude,
    fetchFn = ((input, init) => fetch(input, init)) as FetchFn,
    logger = consoleLogger,
    cooldown = new FailureCooldown(),
  } = options;

  // 회차마다 읽는다 — 프롬프트를 고치고 다음 주기를 기다리면 반영되게 하기 위함.
  const template = options.template ?? loadPromptTemplate();

  const runId = await safeStartWorkerRun(baseUrl, fetchFn, logger);

  try {
    // 1단계: 신규 분석. 항상 먼저 조회하고, 항상 전량 처리한다 — 재분석이 이 한도를
    // 잠식하지 않는다(design.md D4의 "신규 우선").
    // 쿨다운 중인 물건이 한도를 차지하지 않도록 그 수만큼 더 조회한 뒤 걸러서 자른다.
    // (서버 순서가 고정이라 앞쪽 실패 물건이 뒤 물건을 굶기는 것을 막는다.)
    let skippedByCooldown = 0;
    const withCooldown = (pageSize: number): number =>
      Math.min(pageSize + cooldown.coolingCount(), BACKEND_MAX_PAGE_SIZE);
    const pickAvailable = (items: AuctionItem[], limit: number): AuctionItem[] => {
      const picked: AuctionItem[] = [];
      for (const item of items) {
        if (cooldown.isCoolingDown(item.id)) {
          skippedByCooldown += 1;
          continue;
        }
        if (picked.length < limit) picked.push(item);
      }
      return picked;
    };

    const { items: fetchedNew, total: newTotal } = await fetchUnanalyzedItems({
      baseUrl,
      pageSize: withCooldown(maxItemsPerRun),
      fetchFn,
    });
    const newItems = pickAvailable(fetchedNew, maxItemsPerRun);

    // 2단계: 재분석. 한도가 설정된 경우에만 조회한다(하위 호환 기본값 0 → 조회 자체를
    // 생략). 1단계에서 이미 고른 물건은 제외한다 — 코드 리뷰 finding 2 수정 이후로는
    // needsAnalysis=true가 "분석 행이 있는 물건"만 반환하므로 신규(미분석) 물건과 원칙적으로
    // 겹치지 않지만, 이 dedupe는 안전망으로 남겨 둔다(정확성의 전제가 아니다 —
    // repository.ts의 NEEDS_ANALYSIS_PREDICATE 주석 참고).
    let reanalysisItems: AuctionItem[] = [];
    if (maxReanalysisPerRun > 0) {
      const alreadyPicked = new Set(newItems.map((item) => item.id));
      const { items: candidates } = await fetchReanalysisCandidates({
        baseUrl,
        pageSize: withCooldown(maxReanalysisPerRun),
        promptVersion,
        fetchFn,
      });
      reanalysisItems = pickAvailable(
        candidates.filter((item) => !alreadyPicked.has(item.id)),
        maxReanalysisPerRun,
      );
    }

    if (skippedByCooldown > 0) {
      logger.info(`[analyzer] 실패 쿨다운 중이라 ${skippedByCooldown}건 건너뜀`);
    }

    const targets = [...newItems, ...reanalysisItems];

    if (targets.length === 0) {
      const allCooling = skippedByCooldown > 0;
      // 두 메시지를 구분한다: 재분석 조회 자체를 안 한 경우(하위 호환 기본 동작)와
      // 재분석까지 조회했는데도 없는 경우는 "무엇을 확인했는지"가 다르다.
      logger.info(
        allCooling
          ? `[analyzer] 대상 ${skippedByCooldown}건이 전부 쿨다운 중`
          : maxReanalysisPerRun > 0
            ? "[analyzer] 미분석 물건도 재분석 대상도 없음"
            : "[analyzer] 미분석 물건 없음",
      );
      const emptySummary: AnalysisRunSummary = { attempted: 0, succeeded: 0, failed: 0 };
      await safeFinishWorkerRun(baseUrl, fetchFn, logger, runId, {
        outcome: "success",
        detail: { newCount: 0, reanalysisCount: 0, succeeded: 0, failed: 0 },
      });
      return emptySummary;
    }

    logger.info(
      `[analyzer] 신규 ${newItems.length}건(전체 미분석 ${newTotal}건 중), 재분석 ${reanalysisItems.length}건 ` +
        `분석 시작 (prompt=${promptVersion}${model ? `, model=${model}` : ""})`,
    );

    const summary: AnalysisRunSummary = { attempted: 0, succeeded: 0, failed: 0 };

    let abort: { error: unknown; item: AuctionItem } | null = null;

    for (const item of targets) {
      summary.attempted += 1;
      try {
        const prompt = renderItemPrompt(template, item);
        const result = await runClaude({ prompt, model, timeoutMs });
        await postAnalysis({
          baseUrl,
          fetchFn,
          payload: {
            itemId: item.id,
            body: result.text,
            promptVersion,
            // 모델을 알 수 없으면 필드를 아예 빼서 API가 null로 저장하게 둔다.
            ...(result.model ? { model: result.model } : {}),
          },
        });
        summary.succeeded += 1;
        cooldown.recordSuccess(item.id);
        logger.info(`[analyzer] 분석 저장 완료 ${describeItem(item)} (${result.text.length}자)`);
      } catch (error) {
        summary.failed += 1;
        if (classifyFailure(error) === "systemic") {
          // 환경 문제(백엔드 다운, 인증·한도, CLI 실행 불가 등) — 물건 탓이 아니므로 쿨다운에
          // 넣지 않고, 남은 물건도 같은 이유로 실패할 뿐이라 유료 호출을 멈추고 회차를 끝낸다.
          logger.error(
            `[analyzer] 시스템 오류로 회차 중단 ${describeItem(item)} — ${describeError(error)} ` +
              `(남은 ${targets.length - summary.attempted}건 미시도, 쿨다운 미기록)`,
          );
          if (cooldown.recordSystemicAbort(item.id)) {
            logger.warn(
              `[analyzer] ${describeItem(item)}이(가) 시스템 오류로 연속 회차를 중단시켜 쿨다운에 넣습니다 — 오분류 가능성 확인 필요`,
            );
          }
          abort = { error, item };
          break;
        }
        const entry = cooldown.recordFailure(item.id);
        logger.error(
          `[analyzer] 분석 실패 ${describeItem(item)} — ${describeError(error)} ` +
            `(연속 ${entry.consecutiveFailures}회, ${new Date(entry.nextRetryAt).toISOString()} 이후 재시도)`,
        );
      }
    }

    logger.info(
      `[analyzer] 회차 종료 — 시도 ${summary.attempted}건, 성공 ${summary.succeeded}건, 실패 ${summary.failed}건`,
    );

    if (abort) {
      const cause = abort.error;
      await safeFinishWorkerRun(baseUrl, fetchFn, logger, runId, {
        outcome: "failed",
        errorKind: cause instanceof Error ? cause.name : String(cause),
        errorMessage: describeError(cause),
        detail: {
          newCount: newItems.length,
          reanalysisCount: reanalysisItems.length,
          succeeded: summary.succeeded,
          failed: summary.failed,
        },
      });
      return summary;
    }
    cooldown.clearAbortStreak();

    await safeFinishWorkerRun(baseUrl, fetchFn, logger, runId, {
      outcome: "success",
      detail: {
        newCount: newItems.length,
        reanalysisCount: reanalysisItems.length,
        succeeded: summary.succeeded,
        failed: summary.failed,
      },
    });

    return summary;
  } catch (error) {
    // 목록 조회 실패 등 회차 전체의 실패. 기록한 뒤 그대로 다시 던진다 — 호출자
    // (startAnalyzer의 tick, main()의 --once 경로)가 기존과 같은 방식으로 로그를 남기고
    // 계속 진행한다(제어 흐름은 바꾸지 않는다).
    await safeFinishWorkerRun(baseUrl, fetchFn, logger, runId, {
      outcome: "failed",
      errorKind: error instanceof Error ? error.name : String(error),
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

/** env가 있으면 양의 정수로 읽고, 값이 이상하면 조용히 넘기지 않고 throw한다. */
export function readPositiveIntEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name}은(는) 1 이상의 정수여야 합니다 (현재 값: ${raw})`);
  }
  return value;
}

export interface AnalyzerSettings {
  baseUrl: string;
  maxItemsPerRun: number;
  maxReanalysisPerRun: number;
  intervalMs: number;
  model: string | null;
  timeoutMs: number;
  /**
   * `AUCTIONBOSS_ANALYZER_RUNNER`로 정해진 실행기. 생략하면 `runAnalysisOnce`의 기본 실행기
   * (기존 `runClaude` 규칙)를 쓴다 — 설정을 손으로 만드는 기존 호출자(테스트)를 깨지 않는다.
   */
  runner?: RunClaude;
}

/**
 * 설정 파일 값을 기본으로 하고 env로 덮어쓴다. env 우선인 이유는 테스트·수동 실행에서
 * 설정 파일을 건드리지 않고 주기와 건수를 줄이기 위함이다.
 */
export function resolveAnalyzerSettings(): AnalyzerSettings {
  const config = loadCollectorConfig();
  return {
    // 알 수 없는 실행기 값이면 여기서 throw한다 — 첫 회차(분석 요청) 전에 기동이 실패한다.
    runner: resolveRunner(),
    baseUrl: process.env.AUCTIONBOSS_API_BASE ?? DEFAULT_API_BASE,
    maxItemsPerRun: readPositiveIntEnv("AUCTIONBOSS_ANALYZE_MAX") ?? config.analysis.maxItemsPerRun,
    maxReanalysisPerRun:
      readPositiveIntEnv("AUCTIONBOSS_ANALYZE_REANALYZE_MAX") ?? config.analysis.maxReanalysisPerRun,
    intervalMs: readPositiveIntEnv("AUCTIONBOSS_ANALYZE_INTERVAL_MS") ?? config.analysis.intervalMs,
    model: process.env.AUCTIONBOSS_ANALYZE_MODEL || null,
    timeoutMs: readPositiveIntEnv("AUCTIONBOSS_ANALYZE_TIMEOUT_MS") ?? DEFAULT_CLAUDE_TIMEOUT_MS,
  };
}

export interface AnalyzerHandle {
  stop: () => void;
}

/**
 * 상주 실행. collector와 같은 모양이다: 시작 즉시 1회 → 이후 주기 실행,
 * 실행 중 플래그로 중첩 tick을 건너뛴다(로그를 남기므로 조용히 사라지지 않는다).
 */
export function startAnalyzer(
  settings: AnalyzerSettings,
  deps?: { runClaude?: RunClaude; fetchFn?: FetchFn; logger?: Logger },
): AnalyzerHandle {
  const logger = deps?.logger ?? consoleLogger;
  let running = false;
  // 프로세스 수명 동안 유지되는 실패 쿨다운(재시작하면 초기화된다).
  const cooldown = new FailureCooldown();

  const tick = async (): Promise<void> => {
    if (running) {
      logger.warn("[analyzer] 이전 회차가 아직 진행 중이라 이번 주기를 건너뜁니다");
      return;
    }
    running = true;
    try {
      await runAnalysisOnce({
        baseUrl: settings.baseUrl,
        maxItemsPerRun: settings.maxItemsPerRun,
        maxReanalysisPerRun: settings.maxReanalysisPerRun,
        model: settings.model,
        timeoutMs: settings.timeoutMs,
        runClaude: deps?.runClaude ?? settings.runner,
        fetchFn: deps?.fetchFn,
        logger,
        cooldown,
      });
    } catch (error) {
      // 회차 단위 실패(서버 미기동, 응답 형식 변경 등)는 워커를 죽이지 않는다.
      // 다음 주기에 정상 시도한다.
      logger.error(`[analyzer] 회차 실행 실패 — ${describeError(error)}`);
    } finally {
      running = false;
    }
  };

  logger.info(
    `[analyzer] 시작 — base=${settings.baseUrl}, 주기 ${settings.intervalMs}ms, ` +
      `회차당 최대 신규 ${settings.maxItemsPerRun}건/재분석 ${settings.maxReanalysisPerRun}건`,
  );

  void tick();
  const timer = setInterval(() => void tick(), settings.intervalMs);

  return {
    stop: () => {
      clearInterval(timer);
      logger.info("[analyzer] 종료");
    },
  };
}

async function main(): Promise<void> {
  const once = process.argv.slice(2).includes("--once");
  const settings = resolveAnalyzerSettings();

  if (once) {
    consoleLogger.info(
      `[analyzer] 1회 실행 — base=${settings.baseUrl}, 최대 신규 ${settings.maxItemsPerRun}건/` +
        `재분석 ${settings.maxReanalysisPerRun}건${settings.model ? `, model=${settings.model}` : ""}`,
    );
    const summary = await runAnalysisOnce({
      baseUrl: settings.baseUrl,
      maxItemsPerRun: settings.maxItemsPerRun,
      maxReanalysisPerRun: settings.maxReanalysisPerRun,
      model: settings.model,
      timeoutMs: settings.timeoutMs,
      runClaude: settings.runner,
    });
    // 실패가 있으면 종료 코드로 알린다(성공처럼 보이지 않게).
    process.exitCode = summary.failed > 0 ? 1 : 0;
    return;
  }

  const handle = startAnalyzer(settings);

  const shutdown = (signal: string): void => {
    consoleLogger.info(`[analyzer] ${signal} 수신 — 정리 후 종료합니다`);
    handle.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

/**
 * `tsx workers/analyzer.ts`로 직접 실행됐을 때만 워커를 띄운다.
 * 테스트는 이 모듈에서 함수만 import하므로 여기서 스케줄러가 돌면 안 된다.
 * (CJS/ESM 어느 쪽으로 로드돼도 통하도록 `import.meta`/`require.main` 대신 argv를 본다.)
 */
function isDirectRun(): boolean {
  const entry = process.argv[1];
  return typeof entry === "string" && /(^|[\\/])analyzer\.(ts|js|mts|mjs)$/.test(entry);
}

if (isDirectRun()) {
  void main().catch((error: unknown) => {
    consoleLogger.error(`[analyzer] 치명적 오류 — ${describeError(error)}`);
    process.exit(1);
  });
}
