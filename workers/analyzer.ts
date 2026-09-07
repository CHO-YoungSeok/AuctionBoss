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
  postAnalysis,
  type FetchFn,
} from "./lib/api";
import { DEFAULT_CLAUDE_TIMEOUT_MS, runClaudeHeadless, type RunClaude } from "./lib/claude";
import { PROMPT_VERSION, loadPromptTemplate, renderItemPrompt } from "./lib/prompt";

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

export interface AnalysisRunOptions {
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
 * 한 회차 실행.
 *
 * 목록 조회 실패는 회차 전체의 실패라 그대로 throw한다(호출자가 로그를 남긴다).
 * 물건 단위 실패는 여기서 잡아 세기만 하고 절대 밖으로 던지지 않는다.
 */
export async function runAnalysisOnce(options: AnalysisRunOptions): Promise<AnalysisRunSummary> {
  const {
    maxItemsPerRun,
    maxReanalysisPerRun = 0,
    baseUrl = process.env.AUCTIONBOSS_API_BASE ?? DEFAULT_API_BASE,
    promptVersion = PROMPT_VERSION,
    model = null,
    timeoutMs = DEFAULT_CLAUDE_TIMEOUT_MS,
    runClaude = runClaudeHeadless,
    fetchFn = ((input, init) => fetch(input, init)) as FetchFn,
    logger = consoleLogger,
  } = options;

  // 회차마다 읽는다 — 프롬프트를 고치고 다음 주기를 기다리면 반영되게 하기 위함.
  const template = options.template ?? loadPromptTemplate();

  // 1단계: 신규 분석. 항상 먼저 조회하고, 항상 전량 처리한다 — 재분석이 이 한도를
  // 잠식하지 않는다(design.md D4의 "신규 우선").
  const { items: newItems, total: newTotal } = await fetchUnanalyzedItems({
    baseUrl,
    pageSize: maxItemsPerRun,
    fetchFn,
  });

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
      pageSize: maxReanalysisPerRun,
      promptVersion,
      fetchFn,
    });
    reanalysisItems = candidates.filter((item) => !alreadyPicked.has(item.id));
  }

  const targets = [...newItems, ...reanalysisItems];

  if (targets.length === 0) {
    // 두 메시지를 구분한다: 재분석 조회 자체를 안 한 경우(하위 호환 기본 동작)와
    // 재분석까지 조회했는데도 없는 경우는 "무엇을 확인했는지"가 다르다.
    logger.info(
      maxReanalysisPerRun > 0 ? "[analyzer] 미분석 물건도 재분석 대상도 없음" : "[analyzer] 미분석 물건 없음",
    );
    return { attempted: 0, succeeded: 0, failed: 0 };
  }

  logger.info(
    `[analyzer] 신규 ${newItems.length}건(전체 미분석 ${newTotal}건 중), 재분석 ${reanalysisItems.length}건 ` +
      `분석 시작 (prompt=${promptVersion}${model ? `, model=${model}` : ""})`,
  );

  const summary: AnalysisRunSummary = { attempted: targets.length, succeeded: 0, failed: 0 };

  for (const item of targets) {
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
      logger.info(`[analyzer] 분석 저장 완료 ${describeItem(item)} (${result.text.length}자)`);
    } catch (error) {
      summary.failed += 1;
      logger.error(`[analyzer] 분석 실패 ${describeItem(item)} — ${describeError(error)}`);
    }
  }

  logger.info(
    `[analyzer] 회차 종료 — 시도 ${summary.attempted}건, 성공 ${summary.succeeded}건, 실패 ${summary.failed}건`,
  );

  return summary;
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
}

/**
 * 설정 파일 값을 기본으로 하고 env로 덮어쓴다. env 우선인 이유는 테스트·수동 실행에서
 * 설정 파일을 건드리지 않고 주기와 건수를 줄이기 위함이다.
 */
export function resolveAnalyzerSettings(): AnalyzerSettings {
  const config = loadCollectorConfig();
  return {
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
        runClaude: deps?.runClaude,
        fetchFn: deps?.fetchFn,
        logger,
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
