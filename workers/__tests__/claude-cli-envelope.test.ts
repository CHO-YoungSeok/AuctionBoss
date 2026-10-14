/**
 * 실제 CLI는 API 오류 때 종료 코드 1 + 빈 stderr + stdout JSON 봉투로 끝난다.
 * 가짜 실행 파일로 그 형태를 재현해 상태·진단·분류를 확인한다.
 * (claude.test.ts는 SDK를 통째로 모킹하므로 분류 테스트는 여기에 둔다.)
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { ClaudeInvocationError, runClaudeHeadless } from "../lib/claude";
import { classifyFailure } from "../lib/classify-failure";
import { FailureCooldown, SYSTEMIC_ABORT_LIMIT } from "../lib/failure-cooldown";

const dir = mkdtempSync(path.join(tmpdir(), "ab-fake-claude-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function fakeBin(name: string, stdout: string): string {
  const jsonFile = path.join(dir, `${name}.out`);
  writeFileSync(jsonFile, stdout);
  const bin = path.join(dir, name);
  writeFileSync(bin, `#!/bin/sh\ncat > /dev/null\ncat '${jsonFile}'\nexit 1\n`);
  chmodSync(bin, 0o755);
  return bin;
}

async function fail(name: string, stdout: string): Promise<ClaudeInvocationError> {
  const err = await runClaudeHeadless({ prompt: "p", bin: fakeBin(name, stdout) }).catch((e) => e);
  expect(err).toBeInstanceOf(ClaudeInvocationError);
  return err as ClaudeInvocationError;
}

describe("CLI 비정상 종료 + stdout 봉투", () => {
  it("401 봉투 → status 401, diagnostic, systemic", async () => {
    const err = await fail(
      "e401",
      JSON.stringify({
        type: "result",
        is_error: true,
        api_error_status: 401,
        terminal_reason: "api_error",
        result: "Invalid API key · Fix external API key",
      }),
    );
    expect(err.status).toBe(401);
    expect(err.diagnostic).toMatch(/^Invalid API key/);
    expect(classifyFailure(err)).toBe("systemic");
  });

  it("400 + Credit balance is too low → systemic", async () => {
    const err = await fail(
      "e400",
      JSON.stringify({ type: "result", is_error: true, api_error_status: 400, result: "Credit balance is too low" }),
    );
    expect(err.status).toBe(400);
    expect(classifyFailure(err)).toBe("systemic");
  });

  it("400 + 일반 문구 → item", async () => {
    const err = await fail(
      "e400b",
      JSON.stringify({ type: "result", is_error: true, api_error_status: 400, result: "prompt is too long" }),
    );
    expect(classifyFailure(err)).toBe("item");
  });

  it("JSON이 아닌 stdout → item, 진단은 stderr(빈 값)", async () => {
    const err = await fail("enojson", "something went wrong");
    expect(err.status).toBeUndefined();
    expect(err.diagnostic).toBe("");
    expect(classifyFailure(err)).toBe("item");
  });

  it("is_error가 false인 봉투(모델 출력)는 진단으로 쓰지 않는다 → item", async () => {
    const err = await fail(
      "enoerr",
      JSON.stringify({ type: "result", is_error: false, result: "Invalid API key 401호 usage limit" }),
    );
    expect(err.diagnostic).toBe("");
    expect(classifyFailure(err)).toBe("item");
  });

  it("상태 없는 is_error 봉투 + 구독 한도 문구 → systemic", async () => {
    const err = await fail(
      "elimit",
      JSON.stringify({ type: "result", is_error: true, result: "You've hit your limit · resets 5pm" }),
    );
    expect(err.status).toBeUndefined();
    expect(classifyFailure(err)).toBe("systemic");
  });

  it("api_error_status가 null이어도 파싱된다", async () => {
    const err = await fail(
      "enull",
      JSON.stringify({ type: "result", is_error: true, api_error_status: null, result: "Usage limit reached" }),
    );
    expect(err.status).toBeUndefined();
    expect(classifyFailure(err)).toBe("systemic");
  });
});

describe("안전망 연속 중단 기록 초기화", () => {
  it("clearAbortStreak 후에는 다시 처음부터 센다", () => {
    const c = new FailureCooldown();
    for (let i = 0; i < SYSTEMIC_ABORT_LIMIT - 1; i += 1) expect(c.recordSystemicAbort(7)).toBe(false);
    c.clearAbortStreak();
    for (let i = 0; i < SYSTEMIC_ABORT_LIMIT - 1; i += 1) expect(c.recordSystemicAbort(7)).toBe(false);
    expect(c.isCoolingDown(7)).toBe(false);
  });

  it("같은 물건의 item 실패(recordFailure)도 연속 기록을 끊는다", () => {
    const c = new FailureCooldown();
    for (let i = 0; i < SYSTEMIC_ABORT_LIMIT - 1; i += 1) c.recordSystemicAbort(7);
    c.recordFailure(7);
    expect(c.recordSystemicAbort(7)).toBe(false);
  });
});
