/**
 * Spring 구현체 단위 테스트(switch-web-to-data-port 4.3, 4.4). 가짜 `fetch`로 메서드마다 요청의
 * 경로·쿼리·메서드·본문이 design.md D1 표와 같은지, 404가 메서드별 값으로 바뀌는지, 사진 파일의
 * 상태·바이트·헤더가 그대로 넘어가는지 본다.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ItemNotFoundError } from "@/lib/domain";

import { DataSourceError } from "../port";
import { createSpringPort } from "../spring/port";

const BASE = "http://spring.test:8080";

const item = {
  id: 7,
  court: "서울중앙지방법원",
  caseNo: "2025타경1",
  itemNo: "1",
  address: null,
  usageType: null,
  appraisalPrice: null,
  minBidPrice: null,
  auctionDate: null,
  failedBidCount: null,
  status: null,
  firstSeenAt: "2026-01-01T00:00:00.000Z",
  lastSeenAt: "2026-01-01T00:00:00.000Z",
};
const run = {
  id: 1,
  worker: "collector",
  startedAt: "2026-01-01T00:00:00.000Z",
  finishedAt: null,
  outcome: "running",
  errorKind: null,
  errorMessage: null,
  detail: null,
  itemsChanged: null,
};

interface Call {
  method: string;
  path: string;
  search: string;
  body: string | undefined;
}

let calls: Call[];
let routes: Map<string, () => Response>;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
function on(key: string, make: () => Response): void {
  routes.set(key, make);
}

const fakeFetch = (async (input: URL, init?: RequestInit) => {
  const method = init?.method ?? "GET";
  calls.push({
    method,
    path: input.pathname,
    search: input.search,
    body: typeof init?.body === "string" ? init.body : undefined,
  });
  const make = routes.get(`${method} ${input.pathname}`);
  if (!make) throw new Error(`대역에 없는 요청: ${method} ${input.pathname}`);
  return make();
}) as unknown as typeof fetch;

const port = createSpringPort({ baseUrl: BASE, fetch: fakeFetch });

beforeEach(() => {
  calls = [];
  routes = new Map();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

describe("Spring 구현체: 요청 모양(D1 표)", () => {
  it("listItems: 조건을 URL 파라미터로 직렬화해 GET /api/items", async () => {
    on("GET /api/items", () => json({ items: [item], total: 1, page: 2, pageSize: 5 }));
    const result = await port.listItems({ usageTypes: ["아파트", "상가,오피스텔"], sort: "minBidPrice", page: 2, pageSize: 5 });
    expect(result).toEqual({ items: [item], total: 1, page: 2, pageSize: 5 });
    expect(calls).toHaveLength(1);
    const search = new URLSearchParams(calls[0].search);
    expect(search.getAll("usage")).toEqual(["아파트", "상가,오피스텔"]);
    expect(search.get("sort")).toBe("minBidPrice");
    expect(search.get("page")).toBe("2");
    expect(search.get("pageSize")).toBe("5");
  });

  it("listItems: 워커 전용 필드는 조용히 버리지 않고 던진다(요청도 보내지 않는다)", async () => {
    await expect(port.listItems({ needsAnalysis: true, promptVersion: "v1" })).rejects.toThrow(/needsAnalysis/);
    expect(calls).toHaveLength(0);
  });

  it("getItemById: GET /api/items/{id}의 item, 404는 null", async () => {
    on("GET /api/items/7", () => json({ item, analysis: null }));
    on("GET /api/items/8", () => json({ error: "없음" }, 404));
    expect(await port.getItemById(7)).toEqual(item);
    expect(await port.getItemById(8)).toBeNull();
    expect(calls.map((c) => `${c.method} ${c.path}${c.search}`)).toEqual(["GET /api/items/7", "GET /api/items/8"]);
  });

  it("listFilterOptions: GET /api/items/filter-options", async () => {
    const body = { usageTypes: ["a"], sidoValues: ["b"], sigunguValues: ["c"], courtValues: ["d"] };
    on("GET /api/items/filter-options", () => json(body));
    expect(await port.listFilterOptions()).toEqual(body);
    expect(calls[0].search).toBe("");
  });

  it("getAnalysisHistory: GET /api/items/{id}/analyses?limit=, 404는 빈 결과", async () => {
    const analysis = { id: 1, itemId: 7, body: "b", model: null, promptVersion: "v1", analyzedAt: "2026-01-01T00:00:00.000Z" };
    on("GET /api/items/7/analyses", () => json({ analyses: [analysis], total: 4 }));
    on("GET /api/items/8/analyses", () => json({ error: "없음" }, 404));
    expect(await port.getAnalysisHistory(7, { limit: 11 })).toEqual({ analyses: [analysis], total: 4 });
    expect(calls[0].search).toBe("?limit=11");
    expect(await port.getAnalysisHistory(8, { limit: 11 })).toEqual({ analyses: [], total: 0 });
  });

  it("listItemChanges: GET /api/items/{id}/changes의 changes, 404는 빈 배열", async () => {
    const change = { id: 1, itemId: 7, field: "status", oldValue: null, newValue: "x", changedAt: "2026-01-01T00:00:00.000Z", kind: "change" };
    on("GET /api/items/7/changes", () => json({ changes: [change] }));
    on("GET /api/items/8/changes", () => json({ error: "없음" }, 404));
    expect(await port.listItemChanges(7)).toEqual([change]);
    expect(await port.listItemChanges(8)).toEqual([]);
  });

  it("listItemPhotos: GET /api/items/{id}/photos의 photos, 404는 빈 배열", async () => {
    const photo = { id: 1, itemId: 7, seq: 1, fileSize: 70, mimeType: "image/png", collectedAt: "2026-01-01T00:00:00.000Z" };
    on("GET /api/items/7/photos", () => json({ photos: [photo] }));
    on("GET /api/items/8/photos", () => json({ error: "없음" }, 404));
    expect(await port.listItemPhotos(7)).toEqual([photo]);
    expect(await port.listItemPhotos(8)).toEqual([]);
  });

  it("getUnreadCount: GET /api/feed?pageSize=1의 unreadCount", async () => {
    on("GET /api/feed", () => json({ entries: [], total: 0, page: 1, pageSize: 1, unreadCount: 9 }));
    expect(await port.getUnreadCount()).toBe(9);
    expect(calls[0].search).toBe("?pageSize=1");
  });

  it("listBookmarkedItems: GET /api/bookmarks?page=", async () => {
    on("GET /api/bookmarks", () => json({ items: [item], total: 21, page: 2, pageSize: 20 }));
    expect(await port.listBookmarkedItems({ page: 2 })).toEqual({ items: [item], total: 21, page: 2, pageSize: 20 });
    expect(calls[0].search).toBe("?page=2");
  });

  it("listFeed: GET /api/feed?page=, 미확인 개수는 결과에 넣지 않는다", async () => {
    const entry = { id: 1, itemId: 7, itemAddress: null, field: "status", oldValue: null, newValue: "x", changedAt: "2026-01-01T00:00:00.000Z", bookmarkedAt: "2026-01-01T00:00:00.000Z" };
    on("GET /api/feed", () => json({ entries: [entry], total: 1, page: 3, pageSize: 20, unreadCount: 5 }));
    expect(await port.listFeed({ page: 3 })).toStrictEqual({ entries: [entry], total: 1, page: 3, pageSize: 20 });
    expect(calls[0].search).toBe("?page=3");
  });

  it("getWorkerStatus: GET /api/worker-runs/status?worker=", async () => {
    const body = { state: "ok", lastSuccessAt: "2026-01-01T00:00:00.000Z", lastRun: run };
    on("GET /api/worker-runs/status", () => json(body));
    expect(await port.getWorkerStatus("photos")).toEqual(body);
    expect(calls[0].search).toBe("?worker=photos");
  });

  it("summarizeRuns: GET /api/worker-runs/summary?worker=&since=", async () => {
    const body = { totalRuns: 3, successCount: 2, failedCount: 1, blockedCount: 0, skippedCount: 0, runningCount: 0, successRate: 0.67, itemsChanged: 4 };
    on("GET /api/worker-runs/summary", () => json(body));
    expect(await port.summarizeRuns({ worker: "collector", since: "2026-01-01T00:00:00.000Z" })).toEqual(body);
    const search = new URLSearchParams(calls[0].search);
    expect(search.get("worker")).toBe("collector");
    expect(search.get("since")).toBe("2026-01-01T00:00:00.000Z");
  });

  it("listWorkerRuns: GET /api/worker-runs?worker=&pageSize=", async () => {
    on("GET /api/worker-runs", () => json({ runs: [run], total: 1, page: 1, pageSize: 20 }));
    expect(await port.listWorkerRuns({ worker: "analyzer", pageSize: 20 })).toEqual({ runs: [run], total: 1, page: 1, pageSize: 20 });
    expect(new URLSearchParams(calls[0].search).toString()).toBe("worker=analyzer&pageSize=20");
  });

  it("getRotationNextCourtCode: GET /api/collector-state/rotation의 nextCourtCode(없으면 null)", async () => {
    on("GET /api/collector-state/rotation", () => json({ nextCourtCode: "B000210" }));
    expect(await port.getRotationNextCourtCode()).toBe("B000210");
    on("GET /api/collector-state/rotation", () => json({ nextCourtCode: null }));
    expect(await port.getRotationNextCourtCode()).toBeNull();
  });

  it("addBookmark: POST /api/bookmarks {itemId}(201), 404는 ItemNotFoundError", async () => {
    on("POST /api/bookmarks", () => json({ item }, 201));
    await port.addBookmark(7);
    expect(calls[0]).toMatchObject({ method: "POST", path: "/api/bookmarks", body: '{"itemId":7}' });
    on("POST /api/bookmarks", () => json({ error: "없음" }, 404));
    await expect(port.addBookmark(99)).rejects.toBeInstanceOf(ItemNotFoundError);
  });

  it("removeBookmark: DELETE /api/bookmarks/{id}, 404는 ItemNotFoundError", async () => {
    on("DELETE /api/bookmarks/7", () => json({ itemId: 7, bookmarked: false }));
    await port.removeBookmark(7);
    expect(calls[0]).toMatchObject({ method: "DELETE", path: "/api/bookmarks/7" });
    on("DELETE /api/bookmarks/99", () => json({ error: "없음" }, 404));
    await expect(port.removeBookmark(99)).rejects.toBeInstanceOf(ItemNotFoundError);
  });

  it("markFeedRead: POST /api/feed/read(본문·시각 없음)", async () => {
    on("POST /api/feed/read", () => json({ lastReadAt: "2026-01-01T00:00:00.000Z", unreadCount: 0 }));
    await port.markFeedRead();
    expect(calls[0]).toMatchObject({ method: "POST", path: "/api/feed/read", search: "", body: undefined });
  });
});

describe("Spring 구현체: 사진 파일", () => {
  it("200은 상태·바이트·Content-Type·Cache-Control을 그대로 넘긴다", async () => {
    const bytes = new Uint8Array([137, 80, 78, 71, 0, 255]);
    on("GET /api/photos/7/1", () => new Response(bytes, { status: 200, headers: { "content-type": "image/png", "cache-control": "public, max-age=86400, immutable" } }));
    const file = await port.getPhotoFile(7, 1);
    expect(file).toStrictEqual({ status: 200, body: bytes, contentType: "image/png", cacheControl: "public, max-age=86400, immutable" });
  });

  it("404는 본문 문자열을 그대로 넘긴다(Not Found, File Not Found)", async () => {
    on("GET /api/photos/7/9", () => new Response("Not Found", { status: 404 }));
    on("GET /api/photos/7/3", () => new Response("File Not Found", { status: 404 }));
    expect(await port.getPhotoFile(7, 9)).toEqual({ status: 404, message: "Not Found" });
    expect(await port.getPhotoFile(7, 3)).toEqual({ status: 404, message: "File Not Found" });
  });

  it("그 밖의 상태는 DataSourceError다", async () => {
    on("GET /api/photos/7/1", () => new Response("boom", { status: 500 }));
    await expect(port.getPhotoFile(7, 1)).rejects.toMatchObject({ status: 500 });
  });
});

describe("Spring 구현체: 실패는 실패로", () => {
  it("읽기의 404(목록 등 의미 없는 경우)·500·형식 불일치는 DataSourceError", async () => {
    on("GET /api/items", () => json({ error: "boom" }, 500));
    await expect(port.listItems({})).rejects.toBeInstanceOf(DataSourceError);
    on("GET /api/items", () => json({ items: [{ ...item, court: undefined }], total: 1, page: 1, pageSize: 20 }));
    await expect(port.listItems({})).rejects.toBeInstanceOf(DataSourceError);
    on("GET /api/worker-runs/status", () => json({ error: "없음" }, 404));
    await expect(port.getWorkerStatus("collector")).rejects.toMatchObject({ status: 404 });
  });
});

describe("spring 모드는 전역 fetch만 쓴다(4.4)", () => {
  const savedEnv = { source: process.env.AUCTIONBOSS_DATA_SOURCE, base: process.env.AUCTIONBOSS_SPRING_BASE };

  afterEach(async () => {
    const { setDataPortForTesting } = await import("../index");
    setDataPortForTesting(null);
    vi.unstubAllGlobals();
    if (savedEnv.source === undefined) delete process.env.AUCTIONBOSS_DATA_SOURCE;
    else process.env.AUCTIONBOSS_DATA_SOURCE = savedEnv.source;
    if (savedEnv.base === undefined) delete process.env.AUCTIONBOSS_SPRING_BASE;
    else process.env.AUCTIONBOSS_SPRING_BASE = savedEnv.base;
  });

  it("getDataPort()가 환경 변수로 Spring 구현체를 만들고, 읽기가 전역 fetch만 쓴다", async () => {
    process.env.AUCTIONBOSS_DATA_SOURCE = "spring";
    process.env.AUCTIONBOSS_SPRING_BASE = BASE;
    vi.stubGlobal("fetch", fakeFetch);
    on("GET /api/collector-state/rotation", () => json({ nextCourtCode: "X1" }));
    const { getDataPort, setDataPortForTesting } = await import("../index");
    setDataPortForTesting(null);

    expect(await getDataPort().getRotationNextCourtCode()).toBe("X1");
    expect(calls).toHaveLength(1);
  });
});
