/**
 * Antigravity(agy) 실행기 테스트.
 *
 * 봉투 fixture는 agy 1.3.5 실측 출력(2026-10-18, id만 가짜로 교체)이다. 통합 테스트는
 * 가짜 `agy` 셸 스크립트로 argv·cwd·종료 코드·stderr를 재현한다 — 실제 agy는 부르지 않는다.
 * (claude-cli-envelope.test.ts와 같은 방식. 단 agy는 프롬프트를 stdin이 아니라 argv로 받는다.)
 */
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import {
  DEFAULT_AGY_MODEL,
  MAX_AGY_PROMPT_BYTES,
  buildAgyArgs,
  parseAgyEnvelope,
  runAgyHeadless,
} from "../lib/agy";
import { ClaudeInvocationError } from "../lib/claude";
import { classifyFailure } from "../lib/classify-failure";

const USAGE = { input_tokens: 5248, output_tokens: 5, thinking_tokens: 0, cache_read_tokens: 13083, total_tokens: 5253 };

const SUCCESS_ENVELOPE = JSON.stringify({
  conversation_id: "523e0000-0000-4000-8000-000000000001",
  status: "SUCCESS",
  response: "PONG\n",
  duration_seconds: 2.45,
  num_turns: 1,
  usage: USAGE,
});

const BAD_MODEL_ERROR =
  'invalid model selection (--model "no-such-model" --effort ""): model no-such-model is not recognized as a known model or custom model in settings\nAvailable models:\n  gemini-3.8-flash-medium';

const BAD_MODEL_ENVELOPE = JSON.stringify({
  conversation_id: "",
  status: "ERROR",
  response: "",
  error: BAD_MODEL_ERROR,
  duration_seconds: 0,
  num_turns: 0,
  usage: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 0 },
});

const DENIED_ENVELOPE = JSON.stringify({
  conversation_id: "b2a60000-0000-4000-8000-000000000002",
  status: "SUCCESS",
  response: "",
  duration_seconds: 4.6,
  num_turns: 1,
  usage: USAGE,
  denied_actions: [{ action: "command", display_name: "RunCommand" }],
});

const DENIED_STDERR =
  'jetski: no output produced — a tool required the "command" permission that headless mode cannot prompt for, so it was auto-denied.';

const PRINT_TIMEOUT_STDERR = "[agy] print timeout after 2s with turn in progress; returning partial output";

function parseError(stdout: string, stderr = ""): ClaudeInvocationError {
  try {
    parseAgyEnvelope(stdout, stderr);
  } catch (error) {
    expect(error).toBeInstanceOf(ClaudeInvocationError);
    return error as ClaudeInvocationError;
  }
  throw new Error("실패해야 하는 봉투가 통과했습니다");
}

describe("buildAgyArgs", () => {
  it("프롬프트는 -p=<prompt> 한 원소, 격리 옵션 포함", () => {
    const args = buildAgyArgs("분석하라", "gemini-3.8-flash-medium");
    expect(args).toEqual(["-p=분석하라", "--output-format", "json", "--model", "gemini-3.8-flash-medium", "--sandbox"]);
  });

  it("권한 자동 승인과 --print-timeout은 넣지 않는다", () => {
    const args = buildAgyArgs("x", "m");
    expect(args).not.toContain("--dangerously-skip-permissions");
    expect(args.some((a) => a.startsWith("--print-timeout"))).toBe(false);
  });

  it("개행·따옴표·한글·플래그처럼 생긴 프롬프트도 한 원소로 유지된다", () => {
    const prompt = '첫 줄\n두 "번째" \'줄\' $(rm -rf /) --model evil -p x';
    const args = buildAgyArgs(prompt, "m");
    expect(args).toHaveLength(6);
    expect(args[0]).toBe(`-p=${prompt}`);
  });
});

describe("parseAgyEnvelope", () => {
  it("성공 봉투 → 공백을 다듬은 응답 텍스트", () => {
    expect(parseAgyEnvelope(SUCCESS_ENVELOPE, "")).toBe("PONG");
  });

  it("ERROR + error → diagnostic이 error 문구, systemic", () => {
    const err = parseError(BAD_MODEL_ENVELOPE, "error: invalid model selection ...");
    expect(err.diagnostic).toBe(BAD_MODEL_ERROR);
    expect(classifyFailure(err)).toBe("systemic");
  });

  it("denied_actions가 있으면 SUCCESS여도 실패, item", () => {
    const err = parseError(DENIED_ENVELOPE, DENIED_STDERR);
    expect(err.message).toMatch(/denied_actions: RunCommand/);
    expect(classifyFailure(err)).toBe("item");
  });

  it("빈 response → 실패, diagnostic은 stderr", () => {
    const empty = JSON.stringify({ status: "SUCCESS", response: "  \n" });
    const err = parseError(empty, PRINT_TIMEOUT_STDERR);
    expect(err.message).toMatch(/빈 분석 결과/);
    expect(err.diagnostic).toBe(PRINT_TIMEOUT_STDERR);
    expect(classifyFailure(err)).toBe("item");
  });

  it("JSON이 아닌 stdout → 실패", () => {
    const err = parseError("something went wrong", "oops");
    expect(err.message).toMatch(/JSON이 아닙니다/);
    expect(err.diagnostic).toBe("oops");
  });

  it("빈 stdout → 실패", () => {
    expect(parseError("  ").message).toMatch(/아무 출력도/);
  });

  it("필수 필드가 없는 봉투 → 형식 오류", () => {
    expect(parseError(JSON.stringify({ status: "SUCCESS" })).message).toMatch(/형식이 예상과 다릅니다/);
  });

  it("알 수 없는 필드는 통과한다(CLI 버전 업)", () => {
    const text = parseAgyEnvelope(JSON.stringify({ status: "SUCCESS", response: "ok", future_field: { a: 1 } }), "");
    expect(text).toBe("ok");
  });
});

// ---------------------------------------------------------------------------
// 가짜 agy 셸 스크립트 통합 테스트
// ---------------------------------------------------------------------------

const dir = mkdtempSync(path.join(tmpdir(), "ab-fake-agy-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

interface FakeOptions {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  /** 스크립트 본문을 통째로 바꾼다(타임아웃 등). */
  body?: string;
}

/**
 * 가짜 agy. 호출되면 `<name>.called`에 첫 argv·`<name>.argc`·`<name>.cwd`를 남기고
 * 준비된 stdout/stderr/종료 코드를 낸다. stdin은 읽지 않는다(agy도 안 읽는다).
 */
function fakeAgy(name: string, options: FakeOptions = {}): { bin: string; file: (ext: string) => string } {
  const file = (ext: string) => path.join(dir, `${name}.${ext}`);
  writeFileSync(file("out"), options.stdout ?? "");
  writeFileSync(file("err"), options.stderr ?? "");
  const bin = path.join(dir, name);
  const body =
    options.body ??
    [
      `printf '%s' "$1" > '${file("called")}'`,
      `printf '%s' "$#" > '${file("argc")}'`,
      `printf '%s' "$*" > '${file("allargs")}'`,
      `pwd -P > '${file("cwd")}'`,
      `cat '${file("err")}' >&2`,
      `cat '${file("out")}'`,
      `exit ${options.exitCode ?? 0}`,
    ].join("\n");
  writeFileSync(bin, `#!/bin/sh\n${body}\n`);
  chmodSync(bin, 0o755);
  return { bin, file };
}

async function failure(promise: Promise<unknown>): Promise<ClaudeInvocationError> {
  const err = await promise.catch((e) => e);
  expect(err).toBeInstanceOf(ClaudeInvocationError);
  return err as ClaudeInvocationError;
}

describe("runAgyHeadless (가짜 agy)", () => {
  it("성공: 텍스트와 agy:<기본 모델>을 돌려주고, 인자가 그대로 전달된다", async () => {
    const fake = fakeAgy("ok", { stdout: SUCCESS_ENVELOPE });
    const prompt = '한글 "따옴표"\n둘째 줄 $HOME `x`';
    const result = await runAgyHeadless({ prompt, bin: fake.bin });

    expect(result).toEqual({ text: "PONG", model: `agy:${DEFAULT_AGY_MODEL}` });
    expect(readFileSync(fake.file("called"), "utf8")).toBe(`-p=${prompt}`);
    expect(readFileSync(fake.file("argc"), "utf8")).toBe("6");
    const all = readFileSync(fake.file("allargs"), "utf8");
    expect(all).toContain("--sandbox");
    expect(all).toContain(`--model ${DEFAULT_AGY_MODEL}`);
    expect(all).not.toContain("--dangerously-skip-permissions");
    expect(all).not.toContain("--print-timeout");
  });

  it("지정한 모델은 그대로 쓰고 기록에는 agy: 접두사가 붙는다", async () => {
    const fake = fakeAgy("custom-model", { stdout: SUCCESS_ENVELOPE });
    const result = await runAgyHeadless({ prompt: "p", model: "claude-sonnet-5-5", bin: fake.bin });
    expect(result.model).toBe("agy:claude-sonnet-5-5");
    expect(readFileSync(fake.file("allargs"), "utf8")).toContain("--model claude-sonnet-5-5");
  });

  it("종료 1 + ERROR 봉투 → 봉투로 판정(진단=error), systemic", async () => {
    const fake = fakeAgy("badmodel", {
      stdout: BAD_MODEL_ENVELOPE,
      stderr: "error: invalid model selection ...",
      exitCode: 1,
    });
    const err = await failure(runAgyHeadless({ prompt: "p", model: "no-such-model", bin: fake.bin }));
    expect(err.diagnostic).toBe(BAD_MODEL_ERROR);
    expect(classifyFailure(err)).toBe("systemic");
  });

  it("도구 요청 거부(종료 0, SUCCESS + 빈 응답 + denied_actions) → 실패, item", async () => {
    const fake = fakeAgy("denied", { stdout: DENIED_ENVELOPE, stderr: DENIED_STDERR });
    const err = await failure(runAgyHeadless({ prompt: "p", bin: fake.bin }));
    expect(err.message).toMatch(/denied_actions/);
    expect(classifyFailure(err)).toBe("item");
  });

  it("종료 1 + 봉투 없음 → 실행 실패, 진단은 stderr", async () => {
    const fake = fakeAgy("nojson", { stderr: "boom", exitCode: 1 });
    const err = await failure(runAgyHeadless({ prompt: "p", bin: fake.bin }));
    expect(err.message).toMatch(/실행 실패 \(code=1\)/);
    expect(err.diagnostic).toBe("boom");
    expect(classifyFailure(err)).toBe("item");
  });

  it("시간 초과 → 프로세스를 죽이고 오류(item)", async () => {
    const fake = fakeAgy("slow", { body: "exec sleep 30" });
    const started = Date.now();
    const err = await failure(runAgyHeadless({ prompt: "p", timeoutMs: 300, bin: fake.bin }));
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(err.message).toMatch(/300ms 안에 끝나지 않아 종료/);
    expect(classifyFailure(err)).toBe("item");
  });

  it("상한(100 KiB)을 넘는 프롬프트는 프로세스를 띄우지 않는다", async () => {
    const fake = fakeAgy("big", { stdout: SUCCESS_ENVELOPE });
    const err = await failure(runAgyHeadless({ prompt: "a".repeat(MAX_AGY_PROMPT_BYTES + 1), bin: fake.bin }));
    expect(err.message).toMatch(/상한/);
    expect(existsSync(fake.file("called"))).toBe(false);
    expect(classifyFailure(err)).toBe("item");
  });

  it("상한은 문자 수가 아니라 UTF-8 바이트로 잰다", async () => {
    const fake = fakeAgy("bigkr", { stdout: SUCCESS_ENVELOPE });
    // 한글 1자 = 3바이트. 문자 수는 상한 아래지만 바이트는 넘는다.
    const prompt = "가".repeat(Math.ceil(MAX_AGY_PROMPT_BYTES / 3) + 1);
    expect(prompt.length).toBeLessThan(MAX_AGY_PROMPT_BYTES);
    await failure(runAgyHeadless({ prompt, bin: fake.bin }));
    expect(existsSync(fake.file("called"))).toBe(false);
  });

  it("상한 정확히 100 KiB는 실행된다", async () => {
    const fake = fakeAgy("edge", { stdout: SUCCESS_ENVELOPE });
    await runAgyHeadless({ prompt: "a".repeat(MAX_AGY_PROMPT_BYTES), bin: fake.bin });
    expect(existsSync(fake.file("called"))).toBe(true);
  });

  it("실행 파일 없음 → cause.code=ENOENT, systemic", async () => {
    const err = await failure(runAgyHeadless({ prompt: "p", bin: path.join(dir, "does-not-exist") }));
    expect((err.cause as NodeJS.ErrnoException).code).toBe("ENOENT");
    expect(classifyFailure(err)).toBe("systemic");
  });

  it("빈 임시 디렉터리에서 실행되고 끝나면 지워진다(저장소가 cwd가 아니다)", async () => {
    const fake = fakeAgy("cwd", { stdout: SUCCESS_ENVELOPE });
    await runAgyHeadless({ prompt: "p", bin: fake.bin });

    const cwd = readFileSync(fake.file("cwd"), "utf8").trim();
    expect(path.basename(cwd)).toMatch(/^auctionboss-analyze-agy-/);
    expect(cwd.startsWith(process.cwd())).toBe(false);
    expect(existsSync(cwd)).toBe(false);
  });

  it("실패해도 임시 디렉터리를 지운다", async () => {
    const fake = fakeAgy("cwdfail", { stdout: BAD_MODEL_ENVELOPE, exitCode: 1 });
    await failure(runAgyHeadless({ prompt: "p", bin: fake.bin }));
    expect(existsSync(readFileSync(fake.file("cwd"), "utf8").trim())).toBe(false);
  });
});
