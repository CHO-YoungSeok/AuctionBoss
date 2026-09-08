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
  DERIVED_FIGURES_TOKEN,
  ITEM_JSON_TOKEN,
  PROMPT_VERSION,
  loadPromptTemplate,
  renderItemPrompt,
} from "../lib/prompt";

const BASE = "http://localhost:9999";
const TEMPLATE = `분석하라.\n\n\`\`\`json\n${ITEM_JSON_TOKEN}\n\`\`\`\n`;
// renderItemPrompt 자체 테스트 중 파생 지표 블록을 검증하는 케이스는 이 템플릿을 쓴다 —
// 위 TEMPLATE에는 DERIVED_FIGURES_TOKEN이 없어(단순 문자열 교체라 토큰이 없으면 그냥
// 아무 일도 안 일어난다) 파생 지표가 렌더된 프롬프트 어디에도 나타나지 않기 때문이다.
const TEMPLATE_WITH_DERIVED = `분석하라.\n\n${DERIVED_FIGURES_TOKEN}\n\n\`\`\`json\n${ITEM_JSON_TOKEN}\n\`\`\`\n`;

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
 * 회차 기록 API(`POST /api/worker-runs`, `PATCH /api/worker-runs/[id]`)를 흉내 낸다
 * (add-collection-observability 4.5/4.6). "분석 대상 조회/저장" 계약을 검증하는 기존
 * 테스트들은 이 호출의 성공 여부에 관심이 없으므로, 매 fetch 픽스처가 기본으로
 * 성공 응답을 주게 해서 회차 기록이 실패로 로그를 남기며 소음을 만들지 않게 한다.
 * 4.5/4.6 전용 테스트는 이 helper를 안 쓰고 별도로 구성한다.
 */
function handleWorkerRunRequest(url: string, init: RequestInit | undefined): Response | undefined {
  const parsed = new URL(url);
  if (parsed.pathname === "/api/worker-runs" && (init?.method ?? "GET") === "POST") {
    return new Response(JSON.stringify({ id: 1 }), {
      status: 201,
      headers: { "content-type": "application/json" },
    });
  }
  if (/^\/api\/worker-runs\/\d+$/.test(parsed.pathname) && init?.method === "PATCH") {
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  return undefined;
}

/**
 * `GET /api/items`는 주어진 물건 목록을, `POST /api/analyses`는 201을 돌려주는 가짜 서버.
 * `postStatus`로 저장 실패도 흉내 낸다. 회차 기록 API는 기본으로 성공 응답을 준다
 * (`handleWorkerRunRequest`).
 */
function makeFetch(items: AuctionItem[], options?: { postStatus?: number }) {
  const calls: FetchCall[] = [];
  const posts: unknown[] = [];

  const fetchFn = vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url, init });

    const workerRunResponse = handleWorkerRunRequest(url, init);
    if (workerRunResponse) return workerRunResponse;

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

/**
 * 재분석 테스트용 가짜 서버. `analyzed=false`와 `needsAnalysis=true`를 URL로 구분해
 * 서로 다른 물건 목록을 돌려준다 — 실제 API처럼 `pageSize`만큼만 잘라서 응답한다
 * (신규 우선 배정 테스트가 "서버가 한도만큼만 돌려준다"에 의존하기 때문이다).
 */
function makeTwoPassFetch(options: {
  newItems: AuctionItem[];
  reanalysisItems: AuctionItem[];
  postStatus?: number;
}) {
  const { newItems, reanalysisItems, postStatus = 201 } = options;
  const calls: FetchCall[] = [];
  const posts: unknown[] = [];

  const fetchFn = vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url, init });
    const parsed = new URL(url);

    const workerRunResponse = handleWorkerRunRequest(url, init);
    if (workerRunResponse) return workerRunResponse;

    if (parsed.pathname === "/api/items") {
      const pageSize = Number(parsed.searchParams.get("pageSize") ?? "0");
      const pool = parsed.searchParams.get("needsAnalysis") === "true" ? reanalysisItems : newItems;
      const page = pool.slice(0, pageSize);
      return new Response(JSON.stringify({ items: page, total: pool.length, page: 1, pageSize }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    if (parsed.pathname === "/api/analyses") {
      posts.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ ok: postStatus < 400 }), {
        status: postStatus,
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

  // 실데이터 검증 실패(v2)의 회귀 케이스: minArea·minBidPrice·minBidPriceRound1·
  // minBidPriceRateRound1이 전부 non-null인 실제 관측값(NOTES.md §11)을 넣었을 때,
  // 모델에게 계산을 맡기지 않고 렌더된 프롬프트 자체에 계산된 숫자가 이미 박혀 있어야
  // 한다 — 이 assertion이 그 실패를 잡았을 assertion이다.
  it("파생 지표(면적당 가격·차수별 표)가 계산된 숫자 그대로 프롬프트에 박힌다 (실데이터 회귀)", () => {
    const item = makeItem({
      appraisalPrice: 711_000_000,
      minBidPrice: 711_000_000,
      minArea: 84,
      maxArea: 84,
      minBidPriceRound1: 711_000_000,
      minBidPriceRateRound1: 100,
    });
    const prompt = renderItemPrompt(TEMPLATE_WITH_DERIVED, item);

    // 면적당 최저매각가격 = 711,000,000 / 84 = 8,464,285.71... → 반올림 후 천 단위 구분.
    expect(prompt).toContain("면적당 최저매각가격: 8,464,286원/㎡");
    // 1차 표: 가격·감정가 대비 비율이 숫자로 명시돼야 한다.
    expect(prompt).toContain("1차: 711,000,000원 (감정가 대비 100%)");
    expect(prompt).not.toContain("면적 또는 최저매각가격 정보 없음");
    expect(prompt).not.toContain("차수별 최저가 정보 없음");
  });

  it("면적·차수별 값이 전부 없으면 지어내지 않고 계산 불가 이유를 그대로 밝힌다", () => {
    const item = makeItem({
      appraisalPrice: null,
      minBidPrice: null,
      minArea: null,
      maxArea: null,
      minBidPriceRound1: null,
      minBidPriceRound2: null,
      minBidPriceRound3: null,
      minBidPriceRound4: null,
    });
    const prompt = renderItemPrompt(TEMPLATE_WITH_DERIVED, item);

    expect(prompt).toContain("면적당 최저매각가격: 계산 불가 — 면적 또는 최저매각가격 정보 없음");
    expect(prompt).toContain("차수별 최저가 추이: 계산 불가 — 차수별 최저가 정보 없음");
    // 값을 지어내지 않았는지 — "원/㎡"(단위)나 숫자 회차 표가 전혀 없어야 한다.
    expect(prompt).not.toContain("원/㎡");
    expect(prompt).not.toMatch(/\d차: [\d,]+원/);
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

/**
 * v2 프롬프트(enrich-item-fields task 5.1/5.2/5.4). 확장 필드로 가능해진 판단을
 * 실제로 지시하는지, 그리고 권리관계·임차인·등기 정보를 "주어지지 않았다"가 아니라
 * "이 소스에 존재하지 않는다"로 명시하는지를 템플릿 원문으로 고정한다.
 */
describe("analyze-item.md 템플릿 — v2 확장 필드 대응", () => {
  const template = loadPromptTemplate();

  it("면적당 가격·차수별 저감 추이·일괄매각 여부를 다루도록 지시한다", () => {
    expect(template).toContain("면적당 가격");
    expect(template).toContain("차수별 저감 추이");
    expect(template).toContain("일괄매각");
  });

  it("권리관계·임차인·등기 정보가 이 데이터 소스에 존재하지 않는다고 명시한다", () => {
    expect(template).toContain("권리관계·임차인·등기 정보는 이 데이터 소스에 존재하지 않는다");
  });

  it("확장 필드가 전부 null인 물건도 유효한 프롬프트를 만들고, 값 없음에 대한 대체 지시가 살아 있다", () => {
    const item = makeItem({
      minArea: null,
      maxArea: null,
      buildingDescription: null,
      minBidPriceRound1: null,
      minBidPriceRound2: null,
      minBidPriceRound3: null,
      minBidPriceRound4: null,
      minBidPriceRateRound1: null,
      minBidPriceRateRound2: null,
      usageCodeLarge: null,
      usageCodeMedium: null,
      usageCodeSmall: null,
      sido: null,
      sigungu: null,
      dong: null,
      lotNumber: null,
      buildingName: null,
      buildingUnit: null,
      coordinateX: null,
      coordinateY: null,
      coordinateLevel: null,
      auctionTime: null,
      auctionPlace: null,
      auctionDecisionDate: null,
      auctionRound: null,
      note: null,
      duplicateCaseNo: null,
      mergedCaseNo: null,
      courtDepartment: null,
      courtPhone: null,
      statusCode: null,
      itemStatusCode: null,
    });

    const prompt = renderItemPrompt(template, item);

    // 토큰이 남지 않고, 치환된 JSON이 그대로 다시 파싱 가능해야 한다(따옴표 깨짐 없음).
    expect(prompt).not.toContain(ITEM_JSON_TOKEN);
    const json = prompt.slice(prompt.indexOf("{"), prompt.lastIndexOf("}") + 1);
    expect(JSON.parse(json)).toEqual(item);

    // 확장 필드가 전부 null이어도, "없으면 추측하지 말고 이렇게 써라"는 대체 지시가
    // 템플릿에 그대로 남아 있어야 한다 — 모델이 지어낼 여지를 열어두지 않는지 확인.
    expect(prompt).toContain("면적 또는 최저매각가격 정보 없음");
    expect(prompt).toContain("차수별 최저가 정보 없음");
    expect(prompt).toContain("권리관계·임차인·등기 정보는 이 데이터 소스에 존재하지 않는다");
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
    // calls[0]은 이제 회차 시작 기록(POST /api/worker-runs)이다 — 물건 목록 조회 호출을
    // path로 찾는다.
    const itemsCall = calls.find((c) => c.url.startsWith(`${BASE}/api/items`));
    expect(itemsCall?.url).toBe(`${BASE}/api/items?analyzed=false&pageSize=3`);
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

/**
 * 회차 기록(add-collection-observability, design.md D3/D4, tasks 4.5/4.6). analyzer는
 * DB를 직접 쓰지 않으므로 `POST`/`PATCH /api/worker-runs`로만 기록한다 — 이 두 테스트가
 * HTTP 경계에서 실제로 오간 요청을 캡처해서 확인한다.
 */
describe("runAnalysisOnce — 회차 기록(observability)", () => {
  /** 회차 기록 API로 오간 호출만 따로 캡처하는 가짜 서버. */
  function makeObservabilityFetch(items: AuctionItem[]) {
    interface WorkerRunCall {
      method: string;
      url: string;
      body?: unknown;
    }
    const workerRunCalls: WorkerRunCall[] = [];
    let nextRunId = 1;

    const fetchFn = vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
      const parsed = new URL(url);
      const method = init?.method ?? "GET";

      if (parsed.pathname === "/api/worker-runs" && method === "POST") {
        workerRunCalls.push({ method, url });
        return new Response(JSON.stringify({ id: nextRunId++ }), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      }
      if (/^\/api\/worker-runs\/\d+$/.test(parsed.pathname) && method === "PATCH") {
        workerRunCalls.push({
          method,
          url,
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
        });
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (parsed.pathname === "/api/items") {
        return new Response(
          JSON.stringify({ items, total: items.length, page: 1, pageSize: 5 }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (parsed.pathname === "/api/analyses") {
        return new Response(JSON.stringify({ ok: true }), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`예상하지 못한 요청: ${url}`);
    });

    return { fetchFn, workerRunCalls };
  }

  it("4.5 — 분석할 물건이 없어도 회차가 success/0건으로 API에 기록된다(기록 자체가 없어서는 안 된다)", async () => {
    const { fetchFn, workerRunCalls } = makeObservabilityFetch([]);

    const summary = await runAnalysisOnce({
      baseUrl: BASE,
      maxItemsPerRun: 5,
      template: TEMPLATE,
      fetchFn,
      logger: makeLogger(),
    });

    expect(summary).toEqual({ attempted: 0, succeeded: 0, failed: 0 });

    const start = workerRunCalls.find((c) => c.url === `${BASE}/api/worker-runs`);
    expect(start?.method).toBe("POST");

    const finish = workerRunCalls.find((c) => c.url.startsWith(`${BASE}/api/worker-runs/`));
    expect(finish?.method).toBe("PATCH");
    expect(finish?.body).toMatchObject({
      outcome: "success",
      detail: { newCount: 0, reanalysisCount: 0, succeeded: 0, failed: 0 },
    });
  });

  it("4.5 — 신규·재분석 건수와 성공·실패 건수가 종료 기록에 담긴다", async () => {
    const items = [makeItem({ id: 1 }), makeItem({ id: 2 })];
    const { fetchFn, workerRunCalls } = makeObservabilityFetch(items);

    const runClaude = vi.fn(async ({ prompt }: RunClaudeOptions): Promise<ClaudeResult> => {
      if (prompt.includes('"id": 2')) throw new Error("CLI가 죽었다");
      return { text: "요약", model: null };
    });

    const summary = await runAnalysisOnce({
      baseUrl: BASE,
      maxItemsPerRun: 5,
      template: TEMPLATE,
      fetchFn,
      runClaude,
      logger: makeLogger(),
    });

    expect(summary).toEqual({ attempted: 2, succeeded: 1, failed: 1 });

    const finish = workerRunCalls.find((c) => c.url.startsWith(`${BASE}/api/worker-runs/`));
    expect(finish?.body).toMatchObject({
      outcome: "success",
      detail: { newCount: 2, reanalysisCount: 0, succeeded: 1, failed: 1 },
    });
  });

  it("4.6 — 회차 기록 API(서버)가 죽어 있어도 분석 자체는 계속 진행되고 throw하지 않는다", async () => {
    const item = makeItem({ id: 42 });
    const logger = makeLogger();
    const posts: unknown[] = [];

    // 회차 기록 엔드포인트만 매번 네트워크 오류로 실패한다 — "서버가 죽어 있다"를
    // 흉내 낸다. /api/items, /api/analyses는 정상 동작한다.
    const fetchFn = vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
      const parsed = new URL(url);
      if (parsed.pathname.startsWith("/api/worker-runs")) {
        throw new TypeError("fetch failed");
      }
      if (parsed.pathname === "/api/items") {
        return new Response(JSON.stringify({ items: [item], total: 1, page: 1, pageSize: 5 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (parsed.pathname === "/api/analyses") {
        posts.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify({ ok: true }), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`예상하지 못한 요청: ${url}`);
    });

    const summary = await runAnalysisOnce({
      baseUrl: BASE,
      maxItemsPerRun: 5,
      template: TEMPLATE,
      fetchFn,
      runClaude: async () => ({ text: "요약", model: null }),
      logger,
    });

    // 분석 자체(목록 조회 → Claude 호출 → 결과 저장)는 회차 기록과 무관하게 끝까지 끝난다.
    expect(summary).toEqual({ attempted: 1, succeeded: 1, failed: 0 });
    expect(posts).toHaveLength(1);

    // 시작 기록이 실패하면 runId가 없어 종료 기록은 아예 시도하지 않는다(collector의
    // safeFinishRun과 같은 설계) — 로그에는 시작 실패만 남는다.
    const log = logger.lines.join("\n");
    expect(log).toContain("회차 시작 기록 실패");
  });
});

/**
 * 재분석(design.md D4/D5, tasks 5.1-5.4). `runAnalysisOnce`가 두 단계로 대상을 조회하는
 * 규칙만 검증한다 — 실제 재분석 판정(SQL)은 `src/lib/db/__tests__/repository.test.ts`의
 * `listItems — needsAnalysis`가 고정한다.
 */
describe("runAnalysisOnce — 재분석", () => {
  it("maxReanalysisPerRun을 생략하면(기본값 0) 재분석 조회 자체를 하지 않는다(하위 호환)", async () => {
    const newItem = makeItem({ id: 1 });
    // reanalysisItems를 채워도 pageSize=0인 요청 자체가 안 나가야 한다.
    const { fetchFn, calls, posts } = makeTwoPassFetch({
      newItems: [newItem],
      reanalysisItems: [makeItem({ id: 99 })],
    });

    const summary = await runAnalysisOnce({
      baseUrl: BASE,
      maxItemsPerRun: 5,
      template: TEMPLATE,
      fetchFn,
      runClaude: async () => ({ text: "요약", model: null }),
      logger: makeLogger(),
    });

    expect(summary).toEqual({ attempted: 1, succeeded: 1, failed: 0 });
    expect(posts.map((p) => (p as { itemId: number }).itemId)).toEqual([1]);
    expect(calls.filter((c) => c.url.includes("needsAnalysis"))).toHaveLength(0);
  });

  it("신규와 재분석을 각각 조회해 함께 분석하고, 재분석 조회는 워커의 프롬프트 버전을 함께 보낸다", async () => {
    const newItem = makeItem({ id: 1 });
    const reItem = makeItem({ id: 2 });
    const { fetchFn, calls, posts } = makeTwoPassFetch({
      newItems: [newItem],
      reanalysisItems: [reItem],
    });
    const logger = makeLogger();

    const summary = await runAnalysisOnce({
      baseUrl: BASE,
      maxItemsPerRun: 5,
      maxReanalysisPerRun: 3,
      template: TEMPLATE,
      fetchFn,
      runClaude: async () => ({ text: "요약", model: null }),
      logger,
    });

    expect(summary).toEqual({ attempted: 2, succeeded: 2, failed: 0 });
    expect(posts.map((p) => (p as { itemId: number }).itemId).sort()).toEqual([1, 2]);

    const itemCalls = calls.filter((c) => c.url.includes("/api/items"));
    expect(itemCalls).toHaveLength(2);
    expect(itemCalls[0]?.url).toBe(`${BASE}/api/items?analyzed=false&pageSize=5`);
    expect(itemCalls[1]?.url).toBe(
      `${BASE}/api/items?needsAnalysis=true&promptVersion=${PROMPT_VERSION}&pageSize=3`,
    );

    const log = logger.lines.join("\n");
    expect(log).toContain("신규 1건");
    expect(log).toContain("재분석 1건");
  });

  it("재분석 후보에 신규 패스가 이미 고른 물건이 섞여 있으면 제외한다(조건 1이 신규와 겹칠 수 있다, design.md D4)", async () => {
    const shared = makeItem({ id: 1 });
    const onlyReanalysis = makeItem({ id: 2 });
    const { fetchFn, posts } = makeTwoPassFetch({
      newItems: [shared],
      reanalysisItems: [shared, onlyReanalysis],
    });

    const summary = await runAnalysisOnce({
      baseUrl: BASE,
      maxItemsPerRun: 5,
      maxReanalysisPerRun: 5,
      template: TEMPLATE,
      fetchFn,
      runClaude: async () => ({ text: "요약", model: null }),
      logger: makeLogger(),
    });

    expect(summary).toEqual({ attempted: 2, succeeded: 2, failed: 0 });
    // id 1은 신규 패스로 한 번만 처리된다 — 재분석 패스에서 다시 잡히지 않는다.
    expect(posts.map((p) => (p as { itemId: number }).itemId)).toEqual([1, 2]);
  });

  it("스펙 시나리오 — 신규 분석 우선: 회차 총 한도가 후보 합보다 작으면 신규가 먼저 전량 배정되고 재분석은 남은 한도만 쓴다", async () => {
    const newItems = [makeItem({ id: 1 }), makeItem({ id: 2 }), makeItem({ id: 3 })];
    const reanalysisItems = [makeItem({ id: 11 }), makeItem({ id: 12 }), makeItem({ id: 13 })];
    const { fetchFn, posts } = makeTwoPassFetch({ newItems, reanalysisItems });

    const summary = await runAnalysisOnce({
      baseUrl: BASE,
      maxItemsPerRun: 2, // 신규 후보 3건 중 2건만 한도
      maxReanalysisPerRun: 1, // 재분석 후보 3건 중 1건만 한도
      template: TEMPLATE,
      fetchFn,
      runClaude: async () => ({ text: "요약", model: null }),
      logger: makeLogger(),
    });

    expect(summary).toEqual({ attempted: 3, succeeded: 3, failed: 0 });
    const ids = posts.map((p) => (p as { itemId: number }).itemId);
    expect(ids.filter((id) => id === 1 || id === 2)).toHaveLength(2); // 신규는 한도만큼 전량
    expect(ids).toContain(11); // 재분석은 한도(1)만큼만
    expect(ids).not.toContain(3); // 신규 3번째는 이번 회차 한도를 넘는다
    expect(ids).not.toContain(12);
    expect(ids).not.toContain(13);
  });

  it("재분석은 새 POST로 추가될 뿐이다 — 삭제 요청을 보내지 않는다(이전 분석 보존은 저장소가 보장한다, repository.test.ts의 listAnalyses 참고)", async () => {
    const reItem = makeItem({ id: 7 });
    const { fetchFn, calls, posts } = makeTwoPassFetch({ newItems: [], reanalysisItems: [reItem] });

    await runAnalysisOnce({
      baseUrl: BASE,
      maxItemsPerRun: 5,
      maxReanalysisPerRun: 5,
      template: TEMPLATE,
      fetchFn,
      runClaude: async () => ({ text: "재분석 결과", model: null }),
      logger: makeLogger(),
    });

    expect(posts).toEqual([{ itemId: 7, body: "재분석 결과", promptVersion: PROMPT_VERSION }]);
    // PATCH는 회차 종료 기록(add-collection-observability)이다 — 확인하려는 것은 여전히
    // "DELETE가 없다"는 것이다.
    for (const call of calls) {
      expect(["GET", "POST", "PATCH"]).toContain(call.init?.method ?? "GET");
    }
  });

  it("미분석도 재분석 대상도 없으면 Claude를 호출하지 않고 정상 종료한다", async () => {
    const { fetchFn, posts } = makeTwoPassFetch({ newItems: [], reanalysisItems: [] });
    const runClaude = vi.fn();
    const logger = makeLogger();

    const summary = await runAnalysisOnce({
      baseUrl: BASE,
      maxItemsPerRun: 5,
      maxReanalysisPerRun: 3,
      template: TEMPLATE,
      fetchFn,
      runClaude,
      logger,
    });

    expect(summary).toEqual({ attempted: 0, succeeded: 0, failed: 0 });
    expect(runClaude).not.toHaveBeenCalled();
    expect(posts).toHaveLength(0);
    expect(logger.lines.join("\n")).toContain("미분석 물건도 재분석 대상도 없음");
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
