/**
 * Antigravity CLI(`agy`) headless 호출.
 *
 * 설계상 지키는 것들(design.md D2/D3):
 * - **shell을 쓰지 않는다.** `execFile`에 인자 배열로 넘긴다. 프롬프트는 `-p=<prompt>`
 *   한 원소다 — `-p <값>`처럼 띄어 쓰면 `agy`가 다음 플래그를 프롬프트로 먹는다(실측).
 *   stdin 프롬프트는 받지 않으므로 argv 크기 상한(`MAX_AGY_PROMPT_BYTES`)을 직접 지킨다.
 * - **격리.** `agy`는 도구를 끄는 옵션이 없다. `--sandbox` + 빈 임시 디렉터리 cwd +
 *   권한 자동 승인 없음(`--dangerously-skip-permissions` 금지; 헤드리스는 도구 권한을 자동
 *   거부한다)으로 막고, 거부된 요청이 응답에 있으면 결과를 버린다.
 * - **시간 상한은 프로세스를 죽여서 지킨다.** `--print-timeout`은 쓰지 않는다 — 초과해도
 *   `SUCCESS` + 빈 응답을 돌려줘서 실패를 성공으로 위장한다.
 * - **실패를 성공으로 위장하지 않는다.** 상태 비성공·거부된 도구 요청·빈 응답·파싱 실패·
 *   타임아웃은 전부 `ClaudeInvocationError`로 throw한다(분류기가 이미 이 타입을 안다).
 */
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";

import { ClaudeInvocationError, DEFAULT_CLAUDE_TIMEOUT_MS, type RunClaude } from "./claude";

/** 실행 파일 이름. env `AUCTIONBOSS_AGY_BIN`으로 바꿀 수 있다. */
export const DEFAULT_AGY_BIN = "agy";

/** `agy` 실행기의 기본 모델. env `AUCTIONBOSS_ANALYZE_MODEL`이 있으면 그 값이 우선한다. */
export const DEFAULT_AGY_MODEL = "gemini-3.8-flash-medium";

/** 프롬프트는 argv로 넘어간다. Linux 단일 인자 상한(128 KiB) 아래로 여유를 둔다. */
export const MAX_AGY_PROMPT_BYTES = 100 * 1024;

/**
 * `--output-format json` 봉투. 버전마다 필드가 늘어나므로 필요한 것만 검증하고
 * 나머지는 통과시킨다. 응답 봉투에는 모델 필드가 없다(실측).
 */
export const agyEnvelopeSchema = z.object({
  status: z.string(),
  response: z.string(),
  error: z.string().optional(),
  denied_actions: z
    .array(z.object({ action: z.string().optional(), display_name: z.string().optional() }).passthrough())
    .optional(),
});

export type AgyEnvelope = z.infer<typeof agyEnvelopeSchema>;

function truncate(value: string, max = 400): string {
  return value.length <= max ? value : `${value.slice(0, max)}…(${value.length}자)`;
}

/**
 * CLI 인자 조립. 격리 옵션이 빠지거나 금지 옵션이 들어가지 않았는지 테스트로 고정할 수 있게 분리한다.
 */
export function buildAgyArgs(prompt: string, model: string): string[] {
  return ["-p=" + prompt, "--output-format", "json", "--model", model, "--sandbox"];
}

/**
 * stdout(JSON 한 덩어리)을 검증해 응답 텍스트로 바꾼다. 종료 코드는 보지 않는다 —
 * 실패해도 봉투가 stdout에 남는다(잘못된 모델은 종료 1 + ERROR 봉투).
 * 진단(diagnostic)에는 CLI가 직접 낸 문구(error, stderr)만 담는다.
 */
export function parseAgyEnvelope(stdout: string, stderr: string): string {
  const diagnostic = stderr.trim();
  const trimmed = stdout.trim();
  if (!trimmed) {
    throw new ClaudeInvocationError("agy CLI가 아무 출력도 내지 않았습니다", { diagnostic });
  }

  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch (cause) {
    throw new ClaudeInvocationError(`agy CLI 출력이 JSON이 아닙니다: ${truncate(trimmed)}`, {
      cause,
      diagnostic,
    });
  }

  const parsed = agyEnvelopeSchema.safeParse(raw);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join(", ");
    throw new ClaudeInvocationError(`agy CLI 출력 형식이 예상과 다릅니다 — ${details}`, { diagnostic });
  }

  const envelope = parsed.data;
  if (envelope.status !== "SUCCESS") {
    const reason = envelope.error?.trim() || diagnostic;
    throw new ClaudeInvocationError(
      `agy CLI가 오류를 보고했습니다 (status=${envelope.status}): ${truncate(reason || "(내용 없음)")}`,
      { diagnostic: reason },
    );
  }

  const denied = envelope.denied_actions ?? [];
  if (denied.length > 0) {
    // 헤드리스가 자동 거부한 도구 요청. 모델이 도구를 쓰려 했다는 뜻이라 응답을 믿지 않는다.
    // 진단에 "permission denied"를 넣지 않는다 — 분류기가 환경 오류(systemic)로 오인한다.
    // 이건 프롬프트·모델 출력 문제라 물건 단위 실패다.
    const names = denied.map((d) => d.display_name ?? d.action ?? "unknown").join(", ");
    throw new ClaudeInvocationError(`agy CLI가 도구 요청을 거부당했습니다 (denied_actions: ${names})`, {
      diagnostic: `tool request denied by headless mode: ${names}`,
    });
  }

  const text = envelope.response.trim();
  if (!text) {
    throw new ClaudeInvocationError("agy CLI가 빈 분석 결과를 돌려줬습니다", { diagnostic });
  }
  return text;
}

/**
 * 실제 CLI를 띄우는 구현. analyzer는 이 함수를 `RunClaude`로 주입받으므로 단위 테스트는
 * 프로세스를 전혀 띄우지 않는다.
 */
export const runAgyHeadless: RunClaude = async ({
  prompt,
  model,
  timeoutMs = DEFAULT_CLAUDE_TIMEOUT_MS,
  bin = process.env.AUCTIONBOSS_AGY_BIN ?? DEFAULT_AGY_BIN,
}) => {
  const promptBytes = Buffer.byteLength(prompt, "utf8");
  if (promptBytes > MAX_AGY_PROMPT_BYTES) {
    // 프로세스를 띄우기 전에 막는다. 입력이 너무 큰 그 물건만 실패한다(item).
    throw new ClaudeInvocationError(
      `agy CLI 프롬프트가 상한(${MAX_AGY_PROMPT_BYTES}바이트)을 넘습니다 (${promptBytes}바이트)`,
    );
  }

  const effectiveModel = model || DEFAULT_AGY_MODEL;
  // 저장소 밖 빈 디렉터리에서 돌린다. 도구를 끌 수 없으므로 작업 디렉터리가
  // 이 저장소를 가리키지 않게 하는 것이 마지막 방어선이다.
  const workDir = mkdtempSync(path.join(tmpdir(), "auctionboss-analyze-agy-"));

  try {
    const { stdout, stderr } = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      execFile(
        bin,
        buildAgyArgs(prompt, effectiveModel),
        {
          cwd: workDir,
          timeout: timeoutMs,
          killSignal: "SIGKILL",
          maxBuffer: 16 * 1024 * 1024,
          encoding: "utf8",
        },
        (error, out, err) => {
          if (!error) {
            resolve({ stdout: out, stderr: err });
            return;
          }
          const killed = (error as NodeJS.ErrnoException & { killed?: boolean }).killed;
          if (killed) {
            reject(
              new ClaudeInvocationError(`agy CLI가 ${timeoutMs}ms 안에 끝나지 않아 종료했습니다`, {
                cause: error,
              }),
            );
            return;
          }
          // 종료 코드가 0이 아니어도 stdout에 봉투가 있으면 그 봉투로 판정한다(잘못된 모델 등).
          if (out?.trim()) {
            resolve({ stdout: out, stderr: err ?? "" });
            return;
          }
          const code = (error as NodeJS.ErrnoException & { code?: number | string }).code;
          reject(
            new ClaudeInvocationError(
              `agy CLI 실행 실패 (code=${String(code)}): ${truncate(err?.trim() || error.message)}`,
              { cause: error, diagnostic: err?.trim() ?? "" },
            ),
          );
        },
      );
    });

    return { text: parseAgyEnvelope(stdout, stderr), model: `agy:${effectiveModel}` };
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
};
