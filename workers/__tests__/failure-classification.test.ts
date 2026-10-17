/** 실패 분류(item/systemic)와 그에 따른 회차 동작 테스트. */
import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";

import type { AuctionItem } from "@/lib/domain";

import { runAnalysisOnce, type Logger } from "../analyzer";
import { AnalyzerApiError, type FetchFn } from "../lib/api";
import { classifyFailure } from "../lib/classify-failure";
import { parseAgyEnvelope } from "../lib/agy";
import { ClaudeInvocationError } from "../lib/claude";
import { FailureCooldown } from "../lib/failure-cooldown";
import { ITEM_JSON_TOKEN } from "../lib/prompt";

const BASE = "http://localhost:9999";
const TEMPLATE = `분석하라.\n${ITEM_JSON_TOKEN}\n`;

const apiError = (status: number) => Anthropic.APIError.generate(status, { error: { message: "x" } }, "x", new Headers());
const wrapped = (cause: unknown) => new ClaudeInvocationError("Anthropic API 오류", { cause });

const AGY_BAD_MODEL_ERROR =
  'invalid model selection (--model "no-such-model" --effort ""): model no-such-model is not recognized as a known model or custom model in settings\nAvailable models:\n  gemini-3.8-flash-medium';

/** 실제 agy 봉투를 parseAgyEnvelope에 통과시켜 나오는 오류(문자열 하드코딩 대신 진짜 경로). */
function agyFailure(envelope: Record<string, unknown>): ClaudeInvocationError {
  try {
    parseAgyEnvelope(JSON.stringify({ conversation_id: "", duration_seconds: 0, num_turns: 0, ...envelope }), "");
  } catch (error) {
    return error as ClaudeInvocationError;
  }
  throw new Error("agy 봉투가 실패로 판정되지 않았습니다");
}

describe("classifyFailure", () => {
  it.each([
    ["거절", new ClaudeInvocationError("Anthropic API가 응답을 거절했습니다 (category=x)"), "item"],
    ["max_tokens", new ClaudeInvocationError("출력이 잘림(max_tokens=16000)"), "item"],
    ["빈 결과", new ClaudeInvocationError("claude CLI가 빈 분석 결과를 돌려줬습니다"), "item"],
    ["JSON 아님", new ClaudeInvocationError("claude CLI 출력이 JSON이 아닙니다"), "item"],
    ["CLI 타임아웃", new ClaudeInvocationError("claude CLI가 120000ms 안에 끝나지 않아 종료했습니다"), "item"],
    ["API 타임아웃", wrapped(new Anthropic.APIConnectionTimeoutError()), "item"],
    ["저장 400", new AnalyzerApiError("x", 400), "item"],
    ["저장 404", new AnalyzerApiError("x", 404), "item"],
    ["저장 409", new AnalyzerApiError("x", 409), "item"],
    ["저장 413", new AnalyzerApiError("x", 413), "item"],
    ["저장 422", new AnalyzerApiError("x", 422), "item"],
    ["저장 500", new AnalyzerApiError("x", 500), "systemic"],
    ["저장 503", new AnalyzerApiError("x", 503), "systemic"],
    ["저장 401", new AnalyzerApiError("x", 401), "systemic"],
    ["저장 403", new AnalyzerApiError("x", 403), "systemic"],
    ["저장 429", new AnalyzerApiError("x", 429), "systemic"],
    ["백엔드 연결 실패(상태 없음)", new AnalyzerApiError("x"), "systemic"],
    ["Anthropic 400", wrapped(apiError(400)), "item"],
    ["Anthropic 401", wrapped(apiError(401)), "systemic"],
    ["Anthropic 403", wrapped(apiError(403)), "systemic"],
    ["Anthropic 429", wrapped(apiError(429)), "systemic"],
    ["Anthropic 500", wrapped(apiError(500)), "systemic"],
    ["Anthropic 529 과부하", wrapped(apiError(529)), "systemic"],
    ["Anthropic 연결 오류", wrapped(new Anthropic.APIConnectionError({ message: "down" })), "systemic"],
    [
      "CLI 실행 파일 없음(ENOENT)",
      new ClaudeInvocationError("claude CLI 실행 실패 (code=ENOENT)", {
        cause: Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" }),
      }),
      "systemic",
    ],
    ["CLI 크레딧 소진", new ClaudeInvocationError("claude CLI가 오류를 보고했습니다 (subtype=x): Credit balance is too low", { diagnostic: "Credit balance is too low" }), "systemic"],
    ["CLI 인증 오류", new ClaudeInvocationError("claude CLI가 오류를 보고했습니다: Invalid API key", { diagnostic: "Invalid API key" }), "systemic"],
    [
      "H1 빈 stderr + 명령줄의 permission-prompts",
      new ClaudeInvocationError(
        "claude CLI 실행 실패 (code=1): Command failed: claude --print --output-format json --permission-prompts none --no-session-persistence",
        { diagnostic: "" },
      ),
      "item",
    ],
    [
      "H1 빈 stderr + 명령줄/메시지에 한도·인증 단어가 있어도 diagnostic이 없으면 item",
      new ClaudeInvocationError(
        "claude CLI 실행 실패 (code=1): Command failed: claude --print --append-system-prompt rate limit unauthorized overloaded status 429",
        { diagnostic: "" },
      ),
      "item",
    ],
    ["M1 JSON 아님 + 물건 내용 숫자", new ClaudeInvocationError("claude CLI 출력이 JSON이 아닙니다: 401호 500만원 503동", { cause: new SyntaxError("x") }), "item"],
    ["M1 is_error 모델 내용 숫자", new ClaudeInvocationError("claude CLI가 오류를 보고했습니다: 401호 500만원", { diagnostic: "401호 500만원 429동" }), "item"],
    ["M1 진단 API Error 529", new ClaudeInvocationError("x", { diagnostic: "API Error: 529 overloaded" }), "systemic"],
    ["M1 진단 status 401", new ClaudeInvocationError("x", { diagnostic: "request failed with status 401" }), "systemic"],
    ["M2 400 크레딧 소진", wrapped(Anthropic.APIError.generate(400, { error: { message: "Your credit balance is too low to access the API" } }, "Your credit balance is too low to access the API", new Headers())), "systemic"],
    ["M2 일반 400", wrapped(Anthropic.APIError.generate(400, { error: { message: "bad field" } }, "bad field", new Headers())), "item"],
    ["알 수 없는 오류", new Error("boom"), "item"],
    ["Error 아님", "문자열", "item"],
    // agy 실행기. 봉투는 2026-10-18 실측 출력을 줄여 쓴 것이다.
    ["agy 잘못된 모델(실측 봉투)", agyFailure({ status: "ERROR", response: "", error: AGY_BAD_MODEL_ERROR }), "systemic"],
    ["agy RESOURCE_EXHAUSTED", agyFailure({ status: "ERROR", response: "", error: "rpc error: code = RESOURCE_EXHAUSTED desc = out of capacity" }), "systemic"],
    ["agy UNAUTHENTICATED", agyFailure({ status: "ERROR", response: "", error: "rpc error: code = UNAUTHENTICATED desc = token expired" }), "systemic"],
    ["agy 도구 요청 거부", agyFailure({ status: "SUCCESS", response: "", denied_actions: [{ action: "command", display_name: "RunCommand" }] }), "item"],
    ["agy 빈 응답", agyFailure({ status: "SUCCESS", response: "\n" }), "item"],
    ["agy 오류 상태 + 일반 문구", agyFailure({ status: "ERROR", response: "", error: "response was cut off" }), "item"],
  ] as const)("%s → %s", (_name, error, expected) => {
    expect(classifyFailure(error)).toBe(expected);
  });
});

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

/** 신규(analyzed=false)와 재분석(needsAnalysis=true) 후보를 따로 돌려주는 가짜 서버. */
function makeServer(opts: { fresh: number[]; reanalysis?: number[]; postStatus?: (id: number) => number }) {
  const finishes: Array<Record<string, unknown>> = [];
  const fetchFn = vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
    const parsed = new URL(url);
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (parsed.pathname === "/api/worker-runs") return json({ id: 1 }, 201);
    if (/^\/api\/worker-runs\/\d+$/.test(parsed.pathname)) {
      finishes.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return json({ ok: true });
    }
    if (parsed.pathname === "/api/items") {
      const ids = parsed.searchParams.get("needsAnalysis") ? (opts.reanalysis ?? []) : opts.fresh;
      const pageSize = Number(parsed.searchParams.get("pageSize"));
      return json({ items: ids.slice(0, pageSize).map(makeItem), total: ids.length, page: 1, pageSize });
    }
    if (parsed.pathname === "/api/analyses") {
      const id = (JSON.parse(String(init?.body)) as { itemId: number }).itemId;
      return json({ error: "x" }, opts.postStatus?.(id) ?? 201);
    }
    throw new Error(`예상하지 못한 요청: ${url}`);
  });
  return { fetchFn: fetchFn as unknown as FetchFn, calls: fetchFn.mock.calls, finishes };
}

function makeLogger(): Logger & { lines: string[] } {
  const lines: string[] = [];
  return { lines, info: (m) => lines.push(m), warn: (m) => lines.push(m), error: (m) => lines.push(m) };
}

const idOf = (prompt: string) => Number(/"id": (\d+)/.exec(prompt)![1]);

describe("실패 분류에 따른 회차 동작", () => {
  it("저장이 503이면 회차를 중단한다 — 남은 물건에 Claude 호출 없음, 쿨다운 없음, failed 기록", async () => {
    const server = makeServer({ fresh: [1, 2, 3], postStatus: () => 503 });
    const cooldown = new FailureCooldown();
    const attempts: number[] = [];
    const runClaude = vi.fn(async ({ prompt }: { prompt: string }) => {
      attempts.push(idOf(prompt));
      return { text: "분석", model: null };
    });
    const logger = makeLogger();

    const summary = await runAnalysisOnce({
      baseUrl: BASE, maxItemsPerRun: 3, template: TEMPLATE, fetchFn: server.fetchFn, runClaude, logger, cooldown,
    });

    expect(attempts).toEqual([1]);
    expect(cooldown.coolingCount()).toBe(0);
    expect(cooldown.get(1)).toBeUndefined();
    expect(summary).toMatchObject({ attempted: 1, succeeded: 0, failed: 1 });
    expect(server.finishes).toHaveLength(1);
    expect(server.finishes[0]).toMatchObject({ outcome: "failed", errorKind: "AnalyzerApiError" });
    expect(logger.lines.some((l) => l.includes("시스템 오류로 회차 중단"))).toBe(true);
  });

  it("중단 전에 성공한 물건은 성공으로 남는다", async () => {
    const server = makeServer({ fresh: [1, 2, 3], postStatus: (id) => (id === 2 ? 500 : 201) });
    const attempts: number[] = [];
    const summary = await runAnalysisOnce({
      baseUrl: BASE, maxItemsPerRun: 3, template: TEMPLATE, fetchFn: server.fetchFn,
      runClaude: async ({ prompt }) => (attempts.push(idOf(prompt)), { text: "분석", model: null }),
      logger: makeLogger(), cooldown: new FailureCooldown(),
    });
    expect(attempts).toEqual([1, 2]);
    expect(summary).toMatchObject({ succeeded: 1, failed: 1 });
    expect(server.finishes[0]).toMatchObject({ outcome: "failed", detail: { succeeded: 1, failed: 1 } });
  });

  it("거절(물건 탓)이면 쿨다운에 기록하고 다음 물건을 계속 처리한다", async () => {
    const server = makeServer({ fresh: [1, 2] });
    const cooldown = new FailureCooldown();
    const attempts: number[] = [];
    const summary = await runAnalysisOnce({
      baseUrl: BASE, maxItemsPerRun: 2, template: TEMPLATE, fetchFn: server.fetchFn,
      runClaude: async ({ prompt }) => {
        const id = idOf(prompt);
        attempts.push(id);
        if (id === 1) throw new ClaudeInvocationError("Anthropic API가 응답을 거절했습니다 (category=x)");
        return { text: "분석", model: null };
      },
      logger: makeLogger(), cooldown,
    });
    expect(attempts).toEqual([1, 2]);
    expect(cooldown.isCoolingDown(1)).toBe(true);
    expect(cooldown.get(2)).toBeUndefined();
    expect(summary).toMatchObject({ succeeded: 1, failed: 1 });
    expect(server.finishes[0]).toMatchObject({ outcome: "success" });
  });

  it("재분석 후보 중 쿨다운 중인 물건은 제외되고 조회 크기가 늘어난다", async () => {
    const server = makeServer({ fresh: [], reanalysis: [10, 11] });
    const cooldown = new FailureCooldown();
    cooldown.recordFailure(10);
    const attempts: number[] = [];
    await runAnalysisOnce({
      baseUrl: BASE, maxItemsPerRun: 1, maxReanalysisPerRun: 1, template: TEMPLATE, fetchFn: server.fetchFn,
      runClaude: async ({ prompt }) => (attempts.push(idOf(prompt)), { text: "분석", model: null }),
      logger: makeLogger(), cooldown,
    });
    expect(attempts).toEqual([11]);
    const reanalysisCall = server.calls
      .map(([url]) => new URL(url))
      .find((u) => u.searchParams.get("needsAnalysis"));
    expect(reanalysisCall?.searchParams.get("pageSize")).toBe("2");
  });

  it("대상이 전부 쿨다운 중이면 로그가 '전부 쿨다운 중'이다", async () => {
    const server = makeServer({ fresh: [1] });
    const cooldown = new FailureCooldown();
    cooldown.recordFailure(1);
    const logger = makeLogger();
    const summary = await runAnalysisOnce({
      baseUrl: BASE, maxItemsPerRun: 1, template: TEMPLATE, fetchFn: server.fetchFn,
      runClaude: vi.fn(), logger, cooldown,
    });
    expect(summary.attempted).toBe(0);
    expect(logger.lines.some((l) => l.includes("전부 쿨다운 중"))).toBe(true);
    expect(logger.lines.some((l) => l.includes("미분석 물건 없음"))).toBe(false);
  });

  it("안전망 — 같은 물건이 3회 연속 회차를 중단시키면 쿨다운에 들어가 4회차는 다음 물건으로 진행한다", async () => {
    const cooldown = new FailureCooldown();
    const logger = makeLogger();
    const attempts: number[] = [];
    const runOnce = () => {
      const server = makeServer({ fresh: [1, 2] });
      return runAnalysisOnce({
        baseUrl: BASE, maxItemsPerRun: 2, template: TEMPLATE, fetchFn: server.fetchFn,
        runClaude: async ({ prompt }) => {
          const id = idOf(prompt);
          attempts.push(id);
          if (id === 1) throw apiError(500);
          return { text: "분석", model: null };
        },
        logger, cooldown,
      });
    };
    await runOnce();
    await runOnce();
    expect(cooldown.isCoolingDown(1)).toBe(false);
    await runOnce();
    expect(cooldown.isCoolingDown(1)).toBe(true);
    expect(logger.lines.some((l) => l.includes("오분류 가능성"))).toBe(true);
    const summary = await runOnce();
    expect(attempts).toEqual([1, 1, 1, 2]);
    expect(summary).toMatchObject({ attempted: 1, succeeded: 1, failed: 0 });
  });
});

describe("classifyFailure: 구조화된 status가 진단 문구보다 우선한다", () => {
  it("status 529는 문구가 무해해도 systemic", () => {
    expect(classifyFailure(new ClaudeInvocationError("x", { status: 529, diagnostic: "처리하지 못했습니다" }))).toBe("systemic");
  });
  it("status 429는 문구가 없어도 systemic", () => {
    expect(classifyFailure(new ClaudeInvocationError("x", { status: 429, diagnostic: "" }))).toBe("systemic");
  });
  it("status 400(결제 아님)은 문구에 rate limit이 있어도 item", () => {
    expect(
      classifyFailure(new ClaudeInvocationError("x", { status: 400, diagnostic: "prompt mentions rate limit and quota" })),
    ).toBe("item");
  });
  it("status 400 + 결제 문구는 systemic", () => {
    expect(
      classifyFailure(new ClaudeInvocationError("x", { status: 400, diagnostic: "Your credit balance is too low" })),
    ).toBe("systemic");
  });
});
