/**
 * 분석 실행기 선택(`AUCTIONBOSS_ANALYZER_RUNNER`) 테스트.
 * 선택 규칙 자체와, 선택 결과가 analyzer 설정·저장 모델까지 이어지는지를 본다.
 * 기존 claude.test.ts(API 키 규칙)는 건드리지 않는다.
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import type { AuctionItem } from "@/lib/domain";

import { resolveAnalyzerSettings, runAnalysisOnce, startAnalyzer, type Logger } from "../analyzer";
import { DEFAULT_AGY_MODEL, runAgyHeadless } from "../lib/agy";
import type { FetchFn } from "../lib/api";
import { runClaude } from "../lib/claude";
import { ITEM_JSON_TOKEN } from "../lib/prompt";
import { resolveRunner } from "../lib/runner";

const BASE = "http://localhost:9999";
const TEMPLATE = `분석하라.\n${ITEM_JSON_TOKEN}\n`;

const dir = mkdtempSync(path.join(tmpdir(), "ab-runner-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("resolveRunner", () => {
  it.each([
    ["agy", {}, runAgyHeadless],
    ["agy + API 키 → API 키와 무관하게 agy", { ANTHROPIC_API_KEY: "sk-test" }, runAgyHeadless],
  ])("AUCTIONBOSS_ANALYZER_RUNNER=%s", (_name, extra, expected) => {
    expect(resolveRunner({ AUCTIONBOSS_ANALYZER_RUNNER: "agy", ...extra })).toBe(expected);
  });

  it.each([
    ["변수 없음", {}],
    ["변수 없음 + API 키", { ANTHROPIC_API_KEY: "sk-test" }],
    ["빈 값", { AUCTIONBOSS_ANALYZER_RUNNER: "" }],
    ["claude", { AUCTIONBOSS_ANALYZER_RUNNER: "claude" }],
    ["claude + API 키", { AUCTIONBOSS_ANALYZER_RUNNER: "claude", ANTHROPIC_API_KEY: "sk-test" }],
  ])("%s → 기존 규칙(runClaude: API 키 있으면 API, 없으면 CLI)", (_name, env) => {
    expect(resolveRunner(env)).toBe(runClaude);
  });

  it.each(["gemini", "AGY", "Claude", " agy", "antigravity"])("알 수 없는 값 %j → 오류", (value) => {
    expect(() => resolveRunner({ AUCTIONBOSS_ANALYZER_RUNNER: value })).toThrow(/AUCTIONBOSS_ANALYZER_RUNNER/);
  });
});

describe("analyzer 설정", () => {
  it("agy → settings.runner가 agy 실행기, model은 null(기본 모델은 실행기 안에서 정한다)", () => {
    vi.stubEnv("AUCTIONBOSS_ANALYZER_RUNNER", "agy");
    vi.stubEnv("AUCTIONBOSS_ANALYZE_MODEL", "");
    const settings = resolveAnalyzerSettings();
    expect(settings.runner).toBe(runAgyHeadless);
    expect(settings.model).toBeNull();
  });

  it("AUCTIONBOSS_ANALYZE_MODEL은 agy 모델도 덮어쓴다", () => {
    vi.stubEnv("AUCTIONBOSS_ANALYZER_RUNNER", "agy");
    vi.stubEnv("AUCTIONBOSS_ANALYZE_MODEL", "gemini-custom");
    expect(resolveAnalyzerSettings().model).toBe("gemini-custom");
  });

  it("알 수 없는 실행기 값 → 설정 해석에서 즉시 throw, 분석 요청 0건", () => {
    vi.stubEnv("AUCTIONBOSS_ANALYZER_RUNNER", "gemini");
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    expect(() => resolveAnalyzerSettings()).toThrow(/gemini/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// --- 선택 결과가 실제 분석 저장까지 이어지는지 -----------------------------

function makeItem(id: number): AuctionItem {
  return {
    id,
    court: "서울중앙지방법원",
    caseNo: "2025타경12345",
    itemNo: String(id),
    address: "서울특별시 관악구 봉천동 1-1",
    usageType: "아파트",
    appraisalPrice: 500_000_000,
    minBidPrice: 320_000_000,
    auctionDate: "2026-10-15",
    failedBidCount: 2,
    status: "진행",
    firstSeenAt: "2026-09-01T00:00:00.000Z",
    lastSeenAt: "2026-09-06T00:00:00.000Z",
  };
}

function makeServer(ids: number[]) {
  const posted: Array<Record<string, unknown>> = [];
  const fetchFn = vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
    const parsed = new URL(url);
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (parsed.pathname === "/api/worker-runs") return json({ id: 1 }, 201);
    if (/^\/api\/worker-runs\/\d+$/.test(parsed.pathname)) return json({ ok: true });
    if (parsed.pathname === "/api/items") {
      return json({ items: ids.map(makeItem), total: ids.length, page: 1, pageSize: 10 });
    }
    if (parsed.pathname === "/api/analyses") {
      posted.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return json({ ok: true }, 201);
    }
    throw new Error(`예상하지 못한 요청: ${url}`);
  });
  return { fetchFn: fetchFn as unknown as FetchFn, posted };
}

const quietLogger: Logger = { info: () => {}, warn: () => {}, error: () => {} };

function fakeAgyBin(name: string): string {
  const bin = path.join(dir, name);
  const envelope = JSON.stringify({ conversation_id: "523e", status: "SUCCESS", response: "요약 평가\n", num_turns: 1 });
  writeFileSync(bin, `#!/bin/sh\nprintf '%s' '${envelope}'\n`);
  chmodSync(bin, 0o755);
  return bin;
}

describe("agy 실행기 → 분석 저장", () => {
  it("API 키가 있어도 agy를 쓰고(Anthropic 호출 없음), 저장 모델은 agy:<기본 모델>", async () => {
    vi.stubEnv("AUCTIONBOSS_ANALYZER_RUNNER", "agy");
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-test");
    vi.stubEnv("AUCTIONBOSS_AGY_BIN", fakeAgyBin("agy-ok"));
    const sdkFetch = vi.spyOn(globalThis, "fetch");
    const server = makeServer([1]);

    const summary = await runAnalysisOnce({
      baseUrl: BASE,
      maxItemsPerRun: 5,
      template: TEMPLATE,
      runClaude: resolveRunner(),
      fetchFn: server.fetchFn,
      logger: quietLogger,
    });

    expect(summary).toEqual({ attempted: 1, succeeded: 1, failed: 0 });
    expect(server.posted).toHaveLength(1);
    expect(server.posted[0]).toMatchObject({ itemId: 1, body: "요약 평가", model: `agy:${DEFAULT_AGY_MODEL}` });
    expect(sdkFetch).not.toHaveBeenCalled();
  });

  it("startAnalyzer는 settings.runner를 실행기로 쓴다", async () => {
    vi.useFakeTimers();
    try {
      const server = makeServer([1]);
      const runner = vi.fn(async () => ({ text: "분석", model: "agy:test" }));
      const handle = startAnalyzer(
        {
          baseUrl: BASE,
          maxItemsPerRun: 1,
          maxReanalysisPerRun: 0,
          intervalMs: 60_000,
          model: null,
          timeoutMs: 1000,
          runner,
        },
        { fetchFn: server.fetchFn, logger: quietLogger },
      );
      await vi.advanceTimersByTimeAsync(10);
      handle.stop();
      expect(runner).toHaveBeenCalledTimes(1);
      expect(server.posted[0]).toMatchObject({ itemId: 1, model: "agy:test" });
    } finally {
      vi.useRealTimers();
    }
  });
});
