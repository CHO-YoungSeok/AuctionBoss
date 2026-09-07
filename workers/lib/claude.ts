/**
 * Claude Code CLI headless 호출.
 *
 * 설계상 지키는 것들:
 * - **shell을 쓰지 않는다.** 프롬프트에 한글·따옴표·줄바꿈이 들어가므로 셸 문자열로
 *   조립하면 값이 깨지거나 셸이 해석해 버린다. `execFile`에 인자 배열로 넘긴다.
 * - **프롬프트는 stdin으로 넘긴다.** `claude -p`는 프롬프트 인자가 없으면 stdin에서
 *   읽는다. argv 길이 제한(수백 KB)을 아예 만나지 않게 하기 위함이다.
 * - **격리.** 이 저장소의 MCP 서버·설정·CLAUDE.md를 물려받으면 분석 결과가 환경에
 *   따라 달라지고, 최악의 경우 도구로 파일을 건드릴 수 있다. `--strict-mcp-config`,
 *   `--setting-sources ""`, `--tools ""`, 빈 임시 디렉터리 cwd로 막는다.
 * - **실패를 성공으로 위장하지 않는다.** 비정상 종료·타임아웃·파싱 실패·`is_error`·
 *   빈 결과는 전부 throw한다. 호출자(analyzer)가 물건 단위로 잡아 기록한다.
 */
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";

/** 기본 타임아웃(ms). 물건 1건 요약이라 넉넉하게 잡아도 2분이면 충분하다. */
export const DEFAULT_CLAUDE_TIMEOUT_MS = 120_000;

/** CLI 실행 파일 이름. env `AUCTIONBOSS_CLAUDE_BIN`으로 바꿀 수 있다. */
export const DEFAULT_CLAUDE_BIN = "claude";

export interface RunClaudeOptions {
  prompt: string;
  /** `--model`로 넘길 값. 없으면 CLI 기본 모델을 쓴다. */
  model?: string | null;
  timeoutMs?: number;
  bin?: string;
}

export interface ClaudeResult {
  /** 어시스턴트가 낸 최종 텍스트. 그대로 분석 본문으로 저장된다. */
  text: string;
  /** 실제로 쓰인 모델 식별자. CLI 출력에서 알 수 없으면 null. */
  model: string | null;
}

/** 분석 워커가 주입할 수 있는 실행 함수 타입. 테스트는 여기에 가짜를 넣는다. */
export type RunClaude = (options: RunClaudeOptions) => Promise<ClaudeResult>;

export class ClaudeInvocationError extends Error {
  override readonly name = "ClaudeInvocationError";
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}

/**
 * `--output-format json` 봉투. CLI 버전마다 필드가 늘어나므로 필요한 것만 검증하고
 * 나머지는 통과시킨다(strict로 잡으면 CLI 업그레이드 때마다 분석이 멈춘다).
 */
export const claudeEnvelopeSchema = z.object({
  type: z.literal("result", {
    errorMap: () => ({ message: 'type이 "result"가 아닙니다' }),
  }),
  subtype: z.string().optional(),
  is_error: z.boolean(),
  result: z.string().optional(),
  /** 최신 CLI가 top-level model을 주면 그것을 우선 쓴다. */
  model: z.string().optional(),
  modelUsage: z
    .record(
      z.object({
        inputTokens: z.number().optional(),
        outputTokens: z.number().optional(),
        cacheReadInputTokens: z.number().optional(),
        cacheCreationInputTokens: z.number().optional(),
      }),
    )
    .optional(),
});

export type ClaudeEnvelope = z.infer<typeof claudeEnvelopeSchema>;

/**
 * 봉투에서 "이 응답을 실제로 쓴 모델"을 고른다.
 *
 * `modelUsage`에는 본 답변 모델 외에 CLI가 내부적으로 쓰는 보조 모델(제목 생성 등)도
 * 섞여 나온다. 보조 호출은 입력 토큰이 훨씬 적으므로 **입력 토큰 합이 가장 큰 항목**을
 * 본 모델로 본다. 정확한 값이 아니라 기록용 힌트라 이 정도로 충분하고,
 * 알 수 없으면 null을 남긴다(추측한 값을 사실처럼 저장하지 않기 위함).
 */
export function pickModel(envelope: ClaudeEnvelope): string | null {
  if (envelope.model) return envelope.model;
  const usage = envelope.modelUsage;
  if (!usage) return null;

  let best: { name: string; tokens: number } | null = null;
  for (const [name, entry] of Object.entries(usage)) {
    const tokens =
      (entry.inputTokens ?? 0) +
      (entry.cacheReadInputTokens ?? 0) +
      (entry.cacheCreationInputTokens ?? 0);
    if (!best || tokens > best.tokens) best = { name, tokens };
  }
  return best?.name ?? null;
}

/** stdout(JSON 한 덩어리)을 검증해 분석 결과로 바꾼다. */
export function parseClaudeEnvelope(stdout: string): ClaudeResult {
  const trimmed = stdout.trim();
  if (!trimmed) {
    throw new ClaudeInvocationError("claude CLI가 아무 출력도 내지 않았습니다");
  }

  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch (cause) {
    throw new ClaudeInvocationError(
      `claude CLI 출력이 JSON이 아닙니다: ${truncate(trimmed)}`,
      { cause },
    );
  }

  const parsed = claudeEnvelopeSchema.safeParse(raw);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join(", ");
    throw new ClaudeInvocationError(`claude CLI 출력 형식이 예상과 다릅니다 — ${details}`);
  }

  const envelope = parsed.data;
  if (envelope.is_error) {
    throw new ClaudeInvocationError(
      `claude CLI가 오류를 보고했습니다 (subtype=${envelope.subtype ?? "unknown"}): ${
        truncate(envelope.result ?? "(내용 없음)")
      }`,
    );
  }

  const text = envelope.result?.trim() ?? "";
  if (!text) {
    throw new ClaudeInvocationError("claude CLI가 빈 분석 결과를 돌려줬습니다");
  }

  return { text, model: pickModel(envelope) };
}

/**
 * CLI 인자 조립. 테스트에서 격리 옵션이 빠지지 않았는지 확인할 수 있게 분리해 둔다.
 */
export function buildClaudeArgs(model?: string | null): string[] {
  const args = [
    "--print",
    "--output-format",
    "json",
    // 이 저장소의 MCP 서버를 물려받지 않는다.
    "--strict-mcp-config",
    // user/project/local 설정 파일(CLAUDE.md, 커스텀 에이전트 등)을 읽지 않는다.
    "--setting-sources",
    "",
    // 순수 텍스트 작업이라 도구가 필요 없다. 파일을 건드릴 수단 자체를 없앤다.
    "--tools",
    "",
    // 도구가 없어도 만에 하나 권한 프롬프트가 뜨면 붙잡혀 타임아웃 나므로 자동 거절.
    "--permission-prompts",
    "none",
    // 분석 호출은 이어서 쓸 일이 없다. 세션 파일을 남기지 않는다.
    "--no-session-persistence",
  ];
  if (model) args.push("--model", model);
  return args;
}

function truncate(value: string, max = 400): string {
  return value.length <= max ? value : `${value.slice(0, max)}…(${value.length}자)`;
}

/**
 * 실제 CLI를 띄우는 구현. analyzer는 이 함수를 주입받으므로 단위 테스트는
 * 프로세스를 전혀 띄우지 않는다.
 */
export const runClaudeHeadless: RunClaude = async ({
  prompt,
  model,
  timeoutMs = DEFAULT_CLAUDE_TIMEOUT_MS,
  bin = process.env.AUCTIONBOSS_CLAUDE_BIN ?? DEFAULT_CLAUDE_BIN,
}) => {
  // 저장소 밖 빈 디렉터리에서 돌린다. cwd의 CLAUDE.md·설정·git 상태를 물려받지 않고,
  // 도구가 없더라도 작업 디렉터리가 이 저장소를 가리키지 않게 하기 위함이다.
  const workDir = mkdtempSync(path.join(tmpdir(), "auctionboss-analyze-"));

  try {
    const stdout = await new Promise<string>((resolve, reject) => {
      const child = execFile(
        bin,
        buildClaudeArgs(model),
        {
          cwd: workDir,
          timeout: timeoutMs,
          killSignal: "SIGKILL",
          maxBuffer: 16 * 1024 * 1024,
          encoding: "utf8",
        },
        (error, out, err) => {
          if (!error) {
            resolve(out);
            return;
          }
          // execFile은 타임아웃으로 죽였을 때 killed=true를 준다.
          const killed = (error as NodeJS.ErrnoException & { killed?: boolean }).killed;
          if (killed) {
            reject(
              new ClaudeInvocationError(`claude CLI가 ${timeoutMs}ms 안에 끝나지 않아 종료했습니다`, {
                cause: error,
              }),
            );
            return;
          }
          const code = (error as NodeJS.ErrnoException & { code?: number | string }).code;
          reject(
            new ClaudeInvocationError(
              `claude CLI 실행 실패 (code=${String(code)}): ${truncate(err?.trim() || error.message)}`,
              { cause: error },
            ),
          );
        },
      );

      if (!child.stdin) {
        reject(new ClaudeInvocationError("claude CLI의 stdin을 열 수 없습니다"));
        return;
      }
      // stdin 쓰기 실패(예: CLI가 즉시 죽어 EPIPE)로 프로세스가 죽지 않게 흡수한다.
      // 실제 실패 사유는 위 콜백의 종료 코드/stderr로 보고된다.
      child.stdin.on("error", () => {});
      child.stdin.end(prompt);
    });

    return parseClaudeEnvelope(stdout);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
};
