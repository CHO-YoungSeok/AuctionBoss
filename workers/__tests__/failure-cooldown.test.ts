/**
 * 물건별 실패 쿨다운 테스트. 서버는 실제처럼 "분석되지 않은 물건을 고정 순서로 pageSize만큼"
 * 돌려주고, 저장에 성공한 물건은 목록에서 빠진다(상태를 가진 가짜 서버).
 */
import { describe, expect, it, vi } from "vitest";

import type { AuctionItem } from "@/lib/domain";

import { runAnalysisOnce, startAnalyzer, type Logger } from "../analyzer";
import { AnalyzerApiError, type FetchFn } from "../lib/api";
import {
  COOLDOWN_BASE_MS,
  COOLDOWN_MAX_MS,
  FailureCooldown,
} from "../lib/failure-cooldown";
import { ITEM_JSON_TOKEN } from "../lib/prompt";

const BASE = "http://localhost:9999";
const TEMPLATE = `분석하라.\n${ITEM_JSON_TOKEN}\n`;

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
  const pending = new Set(ids);
  const requestedPageSizes: number[] = [];
  const fetchFn = vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
    const parsed = new URL(url);
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (parsed.pathname === "/api/worker-runs") return json({ id: 1 }, 201);
    if (/^\/api\/worker-runs\/\d+$/.test(parsed.pathname)) return json({ ok: true });
    if (parsed.pathname === "/api/items") {
      const pageSize = Number(parsed.searchParams.get("pageSize"));
      requestedPageSizes.push(pageSize);
      const all = [...pending].sort((a, b) => a - b);
      return json({ items: all.slice(0, pageSize).map(makeItem), total: all.length, page: 1, pageSize });
    }
    if (parsed.pathname === "/api/analyses") {
      pending.delete((JSON.parse(String(init?.body)) as { itemId: number }).itemId);
      return json({ ok: true }, 201);
    }
    throw new Error(`예상하지 못한 요청: ${url}`);
  });
  return { fetchFn: fetchFn as unknown as FetchFn, requestedPageSizes };
}

function makeLogger(): Logger & { lines: string[] } {
  const lines: string[] = [];
  return { lines, info: (m) => lines.push(m), warn: (m) => lines.push(m), error: (m) => lines.push(m) };
}

function setup(ids: number[], failIds: Set<number>) {
  let now = 1_000_000;
  const clock = { advance: (ms: number) => (now += ms) };
  const cooldown = new FailureCooldown(() => now);
  const server = makeServer(ids);
  const attempts: number[] = [];
  const runClaude = vi.fn(async ({ prompt }: { prompt: string }) => {
    const id = Number(/"id": (\d+)/.exec(prompt)![1]);
    attempts.push(id);
    if (failIds.has(id)) throw new Error("거절");
    return { text: "분석", model: null };
  });
  const run = (max = 1) =>
    runAnalysisOnce({
      baseUrl: BASE,
      maxItemsPerRun: max,
      template: TEMPLATE,
      fetchFn: server.fetchFn,
      runClaude,
      logger: makeLogger(),
      cooldown,
    });
  return { run, attempts, clock, cooldown, server, failIds };
}

describe("분석 실패 쿨다운", () => {
  it("(a) 실패한 물건은 쿨다운 중 재시도되지 않고 뒤 물건이 분석된다(굶김 회귀)", async () => {
    const t = setup([1, 2], new Set([1]));
    await t.run();
    expect(t.attempts).toEqual([1]);
    await t.run();
    expect(t.attempts).toEqual([1, 2]);
    // 쿨다운 1건 + 한도 1건만큼 조회한다.
    expect(t.server.requestedPageSizes).toEqual([1, 2]);
  });

  it("(b) 쿨다운이 지나면 다시 시도한다", async () => {
    const t = setup([1], new Set([1]));
    await t.run();
    t.clock.advance(COOLDOWN_BASE_MS - 1);
    await t.run();
    expect(t.attempts).toEqual([1]);
    t.clock.advance(1);
    await t.run();
    expect(t.attempts).toEqual([1, 1]);
  });

  it("(c) 성공하면 기록이 지워져 다음 실패는 다시 기본 대기부터 시작한다", async () => {
    const t = setup([1], new Set([1]));
    await t.run();
    t.clock.advance(COOLDOWN_BASE_MS);
    await t.run(); // 2회 연속 실패
    expect(t.cooldown.get(1)?.consecutiveFailures).toBe(2);
    t.clock.advance(COOLDOWN_BASE_MS * 2);
    t.failIds.clear();
    await t.run();
    expect(t.cooldown.get(1)).toBeUndefined();
  });

  it("(d) 백오프는 두 배씩 늘다가 24시간에서 멈춘다", () => {
    const ms = (n: number) => FailureCooldown.backoffMs(n);
    expect(ms(1)).toBe(COOLDOWN_BASE_MS);
    expect(ms(2)).toBe(COOLDOWN_BASE_MS * 2);
    expect(ms(3)).toBe(COOLDOWN_BASE_MS * 4);
    expect(ms(6)).toBe(COOLDOWN_MAX_MS);
    expect(ms(1000)).toBe(COOLDOWN_MAX_MS);
  });

  it("쿨다운을 넘기지 않으면(기본값) 매 회차 같은 물건을 재시도한다(하위 호환)", async () => {
    const server = makeServer([1, 2]);
    const attempts: number[] = [];
    const runClaude = async ({ prompt }: { prompt: string }) => {
      attempts.push(Number(/"id": (\d+)/.exec(prompt)![1]));
      throw new Error("거절");
    };
    for (let i = 0; i < 2; i++) {
      await runAnalysisOnce({
        baseUrl: BASE,
        maxItemsPerRun: 1,
        template: TEMPLATE,
        fetchFn: server.fetchFn,
        runClaude,
        logger: makeLogger(),
      });
    }
    expect(attempts).toEqual([1, 1]);
  });

  it("조회 크기는 쿨다운 수를 더해도 백엔드 상한 200을 넘지 않는다", async () => {
    const t = setup([1], new Set());
    for (let id = 1000; id < 1250; id++) t.cooldown.recordFailure(id);
    await t.run(5);
    expect(t.server.requestedPageSizes).toEqual([200]);
  });

  it("startAnalyzer는 회차 사이에 쿨다운을 유지해 실패 물건을 다음 tick에서 건너뛴다", async () => {
    vi.useFakeTimers();
    try {
      const server = makeServer([1, 2]);
      const attempts: number[] = [];
      const runClaude = async ({ prompt }: { prompt: string }) => {
        const id = Number(/"id": (\d+)/.exec(prompt)![1]);
        attempts.push(id);
        if (id === 1) throw new Error("거절");
        return { text: "분석", model: null };
      };
      const handle = startAnalyzer(
        { baseUrl: BASE, maxItemsPerRun: 1, maxReanalysisPerRun: 0, intervalMs: 1000, model: null, timeoutMs: 1000 },
        { runClaude, fetchFn: server.fetchFn, logger: makeLogger() },
      );
      await vi.advanceTimersByTimeAsync(10);
      await vi.advanceTimersByTimeAsync(1000);
      handle.stop();
      expect(attempts).toEqual([1, 2]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("시스템 오류 연속 중단 안전망 (runAnalysisOnce 수준)", () => {
  it("사이에 중단 없이 끝난 회차가 끼면 연속이 아니므로 3번째 중단에도 쿨다운에 넣지 않는다", async () => {
    const cooldown = new FailureCooldown(() => 1_000_000);
    let visible: number[] = [1];
    const fetchFn = vi.fn(async (url: string): Promise<Response> => {
      const parsed = new URL(url);
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
      if (parsed.pathname === "/api/worker-runs") return json({ id: 1 }, 201);
      if (/^\/api\/worker-runs\/\d+$/.test(parsed.pathname)) return json({ ok: true });
      if (parsed.pathname === "/api/items") {
        return json({ items: visible.map(makeItem), total: visible.length, page: 1, pageSize: 10 });
      }
      if (parsed.pathname === "/api/analyses") return json({ ok: true }, 201);
      throw new Error(`예상하지 못한 요청: ${url}`);
    }) as unknown as FetchFn;
    // 503은 systemic으로 분류돼 회차를 중단시킨다.
    const runClaude = vi.fn(async ({ prompt }: { prompt: string }) => {
      const id = Number(/"id": (\d+)/.exec(prompt)![1]);
      if (id === 1) throw new AnalyzerApiError("서버 오류", 503);
      return { text: "분석", model: null };
    });
    const run = () =>
      runAnalysisOnce({
        baseUrl: BASE,
        maxItemsPerRun: 10,
        template: TEMPLATE,
        fetchFn,
        runClaude,
        logger: makeLogger(),
        cooldown,
      });
    await run(); // 1번째 중단
    await run(); // 2번째 중단
    visible = [2]; // 물건 1이 후보에서 잠시 빠지고 다른 물건만 정상 처리된 회차
    const clean = await run();
    expect(clean.succeeded).toBe(1);
    visible = [1];
    await run(); // 3번째 중단이지만 연속이 아니다
    expect(cooldown.isCoolingDown(1)).toBe(false);
    expect(cooldown.get(1)).toBeUndefined();
  });
});
