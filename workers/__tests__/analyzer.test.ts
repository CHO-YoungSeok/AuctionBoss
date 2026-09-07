/**
 * 분석 워커 단위 테스트.
 *
 * 네트워크도, `claude` 프로세스도 쓰지 않는다. `fetchFn`과 `runClaude`를 주입해
 * "회차 진행 규칙"만 검증한다 — 특히 개별 물건 실패가 회차를 멈추지 않는지.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import type { AuctionItem } from "@/lib/domain";

import { runAnalysisOnce, readPositiveIntEnv, type Logger } from "../analyzer";
import { normalizeBaseUrl, type FetchFn } from "../lib/api";
import {
  ClaudeInvocationError,
  buildClaudeArgs,
  parseClaudeEnvelope,
  pickModel,
  type ClaudeResult,
  type RunClaudeOptions,
} from "../lib/claude";
import {
  ITEM_JSON_TOKEN,
  PROMPT_VERSION,
  loadPromptTemplate,
  renderItemPrompt,
} from "../lib/prompt";

const BASE = "http://localhost:9999";
const TEMPLATE = `분석하라.\n\n\`\`\`json\n${ITEM_JSON_TOKEN}\n\`\`\`\n`;

function makeItem(overrides: Partial<AuctionItem> = {}): AuctionItem {
  return {
    id: 1,
    court: "서울중앙지방법원",
    caseNo: "2025타경12345",
    itemNo: "1",
    address: "서울특별시 관악구 봉천동 1-1",
    usageType: "아파트",
    appraisalPrice: 500_000_000,
    minBidPrice: 320_000_000,
    auctionDate: "2026-10-15",
    failedBidCount: 2,
    status: "진행",
    firstSeenAt: "2026-09-01T00:00:00.000Z",
    lastSeenAt: "2026-09-06T00:00:00.000Z",
    ...overrides,
  };
}

interface FetchCall {
  url: string;
  init?: RequestInit;
}

/**
 * `GET /api/items`는 주어진 물건 목록을, `POST /api/analyses`는 201을 돌려주는 가짜 서버.
 * `postStatus`로 저장 실패도 흉내 낸다.
 */
function makeFetch(items: AuctionItem[], options?: { postStatus?: number }) {
  const calls: FetchCall[] = [];
  const posts: unknown[] = [];

  const fetchFn = vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url, init });

    if (url.startsWith(`${BASE}/api/items`)) {
      return new Response(
        JSON.stringify({ items, total: items.length, page: 1, pageSize: 5 }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    if (url === `${BASE}/api/analyses`) {
      posts.push(JSON.parse(String(init?.body)));
      const status = options?.postStatus ?? 201;
      return new Response(JSON.stringify({ ok: status < 400 }), {
        status,
        headers: { "content-type": "application/json" },
      });
    }

    throw new Error(`예상하지 못한 요청: ${url}`);
  });

  return { fetchFn, calls, posts };
}

function makeLogger(): Logger & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    info: (m) => lines.push(m),
    warn: (m) => lines.push(m),
    error: (m) => lines.push(m),
  };
}

describe("renderItemPrompt", () => {
  it("템플릿의 토큰 자리에 물건 JSON을 그대로 끼워 넣는다", () => {
    const item = makeItem();
    const prompt = renderItemPrompt(TEMPLATE, item);

    expect(prompt).not.toContain(ITEM_JSON_TOKEN);
    expect(prompt).toContain('"caseNo": "2025타경12345"');
    expect(prompt).toContain('"appraisalPrice": 500000000');
    // 치환 결과가 다시 JSON.parse 가능한 형태여야 한다(따옴표가 깨지지 않았는지).
    const json = prompt.slice(prompt.indexOf("{"), prompt.lastIndexOf("}") + 1);
    expect(JSON.parse(json)).toEqual(item);
  });

  it("null 필드도 null로 그대로 전달한다", () => {
    const prompt = renderItemPrompt(TEMPLATE, makeItem({ appraisalPrice: null, address: null }));
    expect(prompt).toContain('"appraisalPrice": null');
    expect(prompt).toContain('"address": null');
  });
});

describe("analyze-item.md 템플릿", () => {
  it("실제 템플릿 파일에 치환 토큰이 있고 프롬프트 버전이 코드와 일치한다", () => {
    const template = loadPromptTemplate();
    expect(template).toContain(ITEM_JSON_TOKEN);
    expect(template).toContain(`prompt_version: ${PROMPT_VERSION}`);
  });

  it("템플릿이 spec의 필수 요소(감정가 대비 최저가 비율, 고지)를 지시한다", () => {
    const raw = readFileSync(
      path.resolve(process.cwd(), "workers/prompts/analyze-item.md"),
      "utf8",
    );
    expect(raw).toContain("minBidPrice / appraisalPrice");
    expect(raw).toContain("권리분석");
    expect(raw).toContain("현장조사");
  });
});

describe("runAnalysisOnce", () => {
  it("미분석 물건이 없으면 Claude를 호출하지도, 결과를 보내지도 않는다", async () => {
    const { fetchFn, posts } = makeFetch([]);
    const runClaude = vi.fn();
    const logger = makeLogger();

    const summary = await runAnalysisOnce({
      baseUrl: BASE,
      maxItemsPerRun: 5,
      template: TEMPLATE,
      fetchFn,
      runClaude,
      logger,
    });

    expect(summary).toEqual({ attempted: 0, succeeded: 0, failed: 0 });
    expect(runClaude).not.toHaveBeenCalled();
    expect(posts).toHaveLength(0);
    expect(logger.lines.join("\n")).toContain("미분석 물건 없음");
  });

  it("정상 물건 1건은 모델이 낸 텍스트 그대로 POST된다", async () => {
    const item = makeItem({ id: 7 });
    const { fetchFn, calls, posts } = makeFetch([item]);
    const runClaude = vi.fn<(options: RunClaudeOptions) => Promise<ClaudeResult>>(async () => ({
      text: "## 요약\n감정가 대비 64.0% 수준이다.",
      model: "claude-sonnet-4-5",
    }));

    const summary = await runAnalysisOnce({
      baseUrl: BASE,
      maxItemsPerRun: 3,
      template: TEMPLATE,
      fetchFn,
      runClaude,
      logger: makeLogger(),
    });

    expect(summary).toEqual({ attempted: 1, succeeded: 1, failed: 0 });
    expect(calls[0]?.url).toBe(`${BASE}/api/items?analyzed=false&pageSize=3`);
    expect(posts).toEqual([
      {
        itemId: 7,
        body: "## 요약\n감정가 대비 64.0% 수준이다.",
        promptVersion: PROMPT_VERSION,
        model: "claude-sonnet-4-5",
      },
    ]);
    // 프롬프트에 실제 물건 데이터가 들어갔는지.
    const passed = runClaude.mock.calls[0]?.[0];
    expect(passed?.model).toBeNull();
    expect(passed?.prompt).toContain("2025타경12345");
  });

  it("모델을 알 수 없으면 model 필드를 빼고 보낸다", async () => {
    const { fetchFn, posts } = makeFetch([makeItem({ id: 3 })]);

    await runAnalysisOnce({
      baseUrl: BASE,
      maxItemsPerRun: 1,
      template: TEMPLATE,
      fetchFn,
      runClaude: async () => ({ text: "요약", model: null }),
      logger: makeLogger(),
    });

    expect(posts[0]).toEqual({ itemId: 3, body: "요약", promptVersion: PROMPT_VERSION });
  });

  it("한 물건이 실패해도 나머지는 계속 분석되고 회차는 throw하지 않는다", async () => {
    const items = [makeItem({ id: 1 }), makeItem({ id: 2 }), makeItem({ id: 3 })];
    const { fetchFn, posts } = makeFetch(items);
    const logger = makeLogger();

    const runClaude = vi.fn(
      async ({ prompt }: RunClaudeOptions): Promise<ClaudeResult> => {
        if (prompt.includes('"id": 2')) throw new Error("CLI가 죽었다");
        return { text: `분석 ${prompt.includes('"id": 1') ? 1 : 3}`, model: null };
      },
    );

    const summary = await runAnalysisOnce({
      baseUrl: BASE,
      maxItemsPerRun: 5,
      template: TEMPLATE,
      fetchFn,
      runClaude,
      logger,
    });

    expect(summary).toEqual({ attempted: 3, succeeded: 2, failed: 1 });
    expect(posts.map((p) => (p as { itemId: number }).itemId)).toEqual([1, 3]);

    const log = logger.lines.join("\n");
    expect(log).toContain("분석 실패 #2");
    expect(log).toContain("CLI가 죽었다");
    expect(log).toContain("시도 3건, 성공 2건, 실패 1건");
  });

  it("깨진 JSON 봉투는 실패로 처리되고 저장되지 않는다", async () => {
    const { fetchFn, posts } = makeFetch([makeItem({ id: 11 })]);
    const logger = makeLogger();

    const summary = await runAnalysisOnce({
      baseUrl: BASE,
      maxItemsPerRun: 1,
      template: TEMPLATE,
      fetchFn,
      // 실제 구현과 같은 경로를 태우려고 파서를 그대로 쓴다.
      runClaude: async () => parseClaudeEnvelope("이건 JSON이 아니다"),
      logger,
    });

    expect(summary).toEqual({ attempted: 1, succeeded: 0, failed: 1 });
    expect(posts).toHaveLength(0);
    expect(logger.lines.join("\n")).toContain("JSON이 아닙니다");
  });

  it("is_error:true 봉투는 실패로 처리되고 저장되지 않는다", async () => {
    const { fetchFn, posts } = makeFetch([makeItem({ id: 12 })]);
    const logger = makeLogger();

    const envelope = JSON.stringify({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      result: "rate limit",
    });

    const summary = await runAnalysisOnce({
      baseUrl: BASE,
      maxItemsPerRun: 1,
      template: TEMPLATE,
      fetchFn,
      runClaude: async () => parseClaudeEnvelope(envelope),
      logger,
    });

    expect(summary).toEqual({ attempted: 1, succeeded: 0, failed: 1 });
    expect(posts).toHaveLength(0);
    expect(logger.lines.join("\n")).toContain("오류를 보고했습니다");
  });

  it("결과 저장이 거절되면(404 등) 실패로 세고 다음 물건으로 넘어간다", async () => {
    const { fetchFn, posts } = makeFetch([makeItem({ id: 1 }), makeItem({ id: 2 })], {
      postStatus: 404,
    });
    const logger = makeLogger();

    const summary = await runAnalysisOnce({
      baseUrl: BASE,
      maxItemsPerRun: 5,
      template: TEMPLATE,
      fetchFn,
      runClaude: async () => ({ text: "요약", model: null }),
      logger,
    });

    expect(summary).toEqual({ attempted: 2, succeeded: 0, failed: 2 });
    // POST 자체는 두 번 다 시도됐다(첫 실패로 회차가 멈추지 않았다).
    expect(posts).toHaveLength(2);
    expect(logger.lines.join("\n")).toContain("404로 거절");
  });

  it("목록 조회 응답 형식이 어긋나면 회차 전체가 실패한다(조용히 넘어가지 않는다)", async () => {
    const fetchFn = vi.fn(
      async () =>
        new Response(JSON.stringify({ items: [{ id: "일곱" }], total: 1, page: 1, pageSize: 5 }), {
          status: 200,
        }),
    );

    await expect(
      runAnalysisOnce({
        baseUrl: BASE,
        maxItemsPerRun: 5,
        template: TEMPLATE,
        fetchFn: fetchFn as unknown as FetchFn,
        runClaude: async () => ({ text: "요약", model: null }),
        logger: makeLogger(),
      }),
    ).rejects.toThrow(/형식이 예상과 다릅니다/);
  });
});

describe("buildClaudeArgs", () => {
  it("headless JSON 출력과 격리 옵션을 항상 붙인다", () => {
    const args = buildClaudeArgs();
    expect(args).toContain("--print");
    expect(args.join(" ")).toContain("--output-format json");
    expect(args).toContain("--strict-mcp-config");
    expect(args).toContain("--setting-sources");
    expect(args).toContain("--tools");
    // 프롬프트를 argv로 넘기지 않는다(stdin 사용).
    expect(args.some((a) => a.includes("분석"))).toBe(false);
    expect(args).not.toContain("--model");
  });

  it("모델이 지정되면 --model을 붙인다", () => {
    expect(buildClaudeArgs("sonnet").slice(-2)).toEqual(["--model", "sonnet"]);
  });
});

describe("parseClaudeEnvelope", () => {
  it("정상 봉투에서 result 텍스트와 모델을 뽑는다", () => {
    const envelope = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "  분석 본문  ",
      modelUsage: {
        "claude-haiku-4-5": { inputTokens: 900, outputTokens: 10 },
        "claude-sonnet-4-5": { inputTokens: 2, cacheCreationInputTokens: 4000, outputTokens: 300 },
      },
    });

    expect(parseClaudeEnvelope(envelope)).toEqual({
      text: "분석 본문",
      model: "claude-sonnet-4-5",
    });
  });

  it("빈 결과는 성공으로 보지 않는다", () => {
    const envelope = JSON.stringify({ type: "result", is_error: false, result: "   " });
    expect(() => parseClaudeEnvelope(envelope)).toThrow(ClaudeInvocationError);
  });

  it("modelUsage가 없으면 모델을 null로 남긴다", () => {
    expect(pickModel({ type: "result", is_error: false })).toBeNull();
  });
});

describe("보조 유틸", () => {
  it("normalizeBaseUrl은 끝 슬래시를 제거한다", () => {
    expect(normalizeBaseUrl("http://localhost:3000/")).toBe("http://localhost:3000");
    expect(normalizeBaseUrl("http://localhost:3000")).toBe("http://localhost:3000");
  });

  it("readPositiveIntEnv는 잘못된 값을 기본값으로 조용히 바꾸지 않는다", () => {
    const name = "AUCTIONBOSS_TEST_ENV_VALUE";
    process.env[name] = "0";
    expect(() => readPositiveIntEnv(name)).toThrow(/1 이상의 정수/);
    process.env[name] = "3";
    expect(readPositiveIntEnv(name)).toBe(3);
    delete process.env[name];
    expect(readPositiveIntEnv(name)).toBeUndefined();
  });
});
