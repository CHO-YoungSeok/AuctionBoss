/**
 * 회귀 방어: AUCTIONBOSS_ANALYZER_RUNNER 미설정 시 기존 동작 유지, 진단 정규식 확장이
 * 기존 물건 단위(item) 진단을 systemic으로 뒤집지 않는지.
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { resolveAnalyzerSettings, runAnalysisOnce, type Logger } from "../analyzer";
import { classifyFailure } from "../lib/classify-failure";
import { ClaudeInvocationError, runClaude } from "../lib/claude";
import { ITEM_JSON_TOKEN } from "../lib/prompt";
import type { FetchFn } from "../lib/api";

const dir = mkdtempSync(path.join(tmpdir(), "ab-runner-default-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
afterEach(() => vi.unstubAllEnvs());

const quiet: Logger = { info: () => {}, warn: () => {}, error: () => {} };

describe("러너 미설정 = 기존 선택", () => {
  it.each([[undefined], [""], ["claude"]])("RUNNER=%j → settings.runner === runClaude", (value) => {
    vi.stubEnv("AUCTIONBOSS_ANALYZER_RUNNER", value as string);
    if (value === undefined) delete process.env.AUCTIONBOSS_ANALYZER_RUNNER;
    expect(resolveAnalyzerSettings().runner).toBe(runClaude);
  });

  it("settings.runner 없이 runAnalysisOnce(runClaude 생략) → 기존 claude CLI 경로(API 키 없음)", async () => {
    const bin = path.join(dir, "claude-fake");
    const envelope = JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "기존 경로", modelUsage: { "claude-x": { inputTokens: 1, outputTokens: 1 } } });
    writeFileSync(bin, `#!/bin/sh\ncat >/dev/null\nprintf '%s' '${envelope}'\n`);
    chmodSync(bin, 0o755);
    vi.stubEnv("AUCTIONBOSS_CLAUDE_BIN", bin);
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.AUCTIONBOSS_ANALYZER_RUNNER;
    const posted: Array<Record<string, unknown>> = [];
    const fetchFn = (async (url: string, init?: RequestInit) => {
      const p = new URL(url).pathname;
      const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json" } });
      if (p === "/api/worker-runs") return json({ id: 1 }, 201);
      if (/^\/api\/worker-runs\/\d+$/.test(p)) return json({ ok: true });
      if (p === "/api/items")
        return json({ items: [{ id: 1, court: "c", caseNo: "n", itemNo: "1", address: "a", usageType: "아파트", appraisalPrice: 1, minBidPrice: 1, auctionDate: "2026-10-15", failedBidCount: 0, status: "진행", firstSeenAt: "2026-09-01T00:00:00.000Z", lastSeenAt: "2026-09-06T00:00:00.000Z" }], total: 1, page: 1, pageSize: 10 });
      if (p === "/api/analyses") { posted.push(JSON.parse(String(init?.body))); return json({ ok: true }, 201); }
      throw new Error(url);
    }) as unknown as FetchFn;
    const summary = await runAnalysisOnce({ baseUrl: "http://x", maxItemsPerRun: 1, template: `a\n${ITEM_JSON_TOKEN}\n`, runClaude: resolveAnalyzerSettings().runner, fetchFn, logger: quiet });
    expect(summary.succeeded).toBe(1);
    expect(posted[0]).toMatchObject({ body: "기존 경로" });
  });
});

describe("SYSTEMIC_DIAGNOSTIC 확장이 물건 단위 진단을 뒤집지 않는다", () => {
  it.each([
    "Prompt is too long",
    "Could not process image",
    "Output blocked by content filtering policy",
    "Execution error: unexpected end of JSON input",
    "Request timed out",
    "Context window exceeded",
    "The tool could not sign the document",
    "Invalid request: field 'x' is required",
    "claude CLI가 빈 분석 결과를 돌려줬습니다",
    "tool request denied by headless mode: RunCommand",
    "response was cut off",
    "",
  ])("claude is_error 진단 %j → item", (diagnostic) => {
    const error = new ClaudeInvocationError("claude CLI가 오류를 보고했습니다", { diagnostic });
    expect(classifyFailure(error)).toBe("item");
  });

  it.each([
    "Please sign in to continue",
    "OAuth token has expired",
    "rpc error: code = UNAUTHENTICATED",
    "please login again",
  ])("인증 문구 %j → systemic (의도된 확장)", (diagnostic) => {
    expect(classifyFailure(new ClaudeInvocationError("x", { diagnostic }))).toBe("systemic");
  });
});
