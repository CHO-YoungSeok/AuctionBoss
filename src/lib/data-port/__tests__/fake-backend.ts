/**
 * Spring 백엔드 대역(migrate-data-and-cutover 8.2, design D12).
 *
 * SQLite·Next 라우트 핸들러가 은퇴해, 화면·폼·사진 라우트 테스트는 "백엔드가 이 JSON을 돌려준다"는
 * 대역 `fetch` 위에서 Spring 구현체(`createSpringPort`)를 그대로 태운다. 대역은 계산을 하지 않는다 —
 * 테스트가 넣은 상태(물건·분석·변경·피드·회차 등)를 백엔드 API의 JSON 형태로 내보낼 뿐이다. 필터·정렬·
 * 변경 감지·미확인 판정 같은 데이터 쪽 로직은 백엔드(Java) 테스트와 동결된 계약 골든이 맡는다.
 *
 * 받은 요청은 `(메서드, 경로 틀, 쿼리 키 집합)`으로 기록한다(요청 수 검사, 골든 포함 검사).
 */
import { afterEach, beforeEach } from "vitest";

import { setDataPortForTesting } from "../index";
import type { DataPort, ItemPhotoMeta } from "../port";
import { createSpringPort } from "../spring/port";
import type {
  Analysis,
  AuctionItem,
  AuctionItemInput,
  FeedEntry,
  ItemChange,
  WatchedField,
  WorkerKind,
  WorkerRun,
  WorkerStatus,
} from "@/lib/domain";

/** 받은 요청의 틀. 경로의 숫자·`{변수}` 구간은 `{id}`로, 쿼리는 키 집합(정렬)으로 줄인다. */
export interface RequestShape {
  method: string;
  path: string;
  queryKeys: string[];
}

export function requestShape(method: string, pathname: string, queryKeys: Iterable<string>): RequestShape {
  const path = pathname
    .split("/")
    .map((segment) => (/^-?\d+$/.test(segment) || /^\{\w+\}$/.test(segment) ? "{id}" : segment))
    .join("/");
  return { method: method.toUpperCase(), path, queryKeys: [...new Set(queryKeys)].sort() };
}

export function shapeKey(shape: RequestShape): string {
  return `${shape.method} ${shape.path}${shape.queryKeys.length > 0 ? `?${shape.queryKeys.join("&")}` : ""}`;
}

export const BASE_URL = "http://backend.test:8080";
export const PHOTO_CACHE_CONTROL = "public, max-age=86400, immutable";
const PAGE_SIZE = 20;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function pageOf<T>(rows: T[], search: URLSearchParams): { rows: T[]; page: number; pageSize: number } {
  const pageSize = Number(search.get("pageSize") ?? PAGE_SIZE);
  const page = Math.max(1, Number(search.get("page") ?? 1));
  return { rows: rows.slice((page - 1) * pageSize, page * pageSize), page, pageSize };
}

export class FakeBackend {
  items: AuctionItem[] = [];
  analyses: Analysis[] = [];
  changes: ItemChange[] = [];
  photos: ItemPhotoMeta[] = [];
  photoFiles = new Map<string, { bytes: Uint8Array; contentType: string }>();
  bookmarks: { itemId: number; at: string }[] = [];
  /** 피드 항목은 테스트가 직접 넣는다(변경 감지는 백엔드의 일이다). 최신순 정렬은 대역이 한다. */
  feedEntries: FeedEntry[] = [];
  lastReadAt: string | null = null;
  runs: WorkerRun[] = [];
  rotationNextCourtCode: string | null = null;
  /** 받은 요청(순서대로). */
  requests: RequestShape[] = [];
  /** 경로(`GET /api/feed`)별로 응답을 바꿔 끼운다(실패 주입용). */
  private overrides = new Map<string, () => Response>();
  now: () => string = () => new Date().toISOString();

  reset(): void {
    this.items = [];
    this.analyses = [];
    this.changes = [];
    this.photos = [];
    this.photoFiles = new Map();
    this.bookmarks = [];
    this.feedEntries = [];
    this.lastReadAt = null;
    this.runs = [];
    this.rotationNextCourtCode = null;
    this.requests = [];
    this.overrides = new Map();
    this.now = () => new Date().toISOString();
  }

  /** `METHOD /path`의 응답을 바꿔 끼운다. */
  override(key: string, make: () => Response): void {
    this.overrides.set(key, make);
  }

  // ---- 상태 넣기 ----

  addItem(input: AuctionItemInput, extra: Partial<AuctionItem> = {}): AuctionItem {
    const id = extra.id ?? this.items.length + 1;
    const item: AuctionItem = {
      ...input,
      id,
      firstSeenAt: "2026-01-01T00:00:00.000Z",
      lastSeenAt: "2026-01-01T00:00:00.000Z",
      lastChangedAt: null,
      photoStatus: "uncollected",
      photoCount: 0,
      photoCollectedAt: null,
      ...extra,
    };
    this.items.push(item);
    return item;
  }

  addAnalysis(itemId: number, input: { body: string; model?: string | null; promptVersion?: string }): Analysis {
    const id = this.analyses.length + 1;
    const analysis: Analysis = {
      id,
      itemId,
      body: input.body,
      model: input.model ?? null,
      promptVersion: input.promptVersion ?? "v3",
      analyzedAt: `2026-02-01T00:00:${String(id % 60).padStart(2, "0")}.000Z`,
    };
    this.analyses.push(analysis);
    return analysis;
  }

  addChange(itemId: number, field: WatchedField, oldValue: string | null, newValue: string | null, changedAt: string): ItemChange {
    const change: ItemChange = {
      id: this.changes.length + 1,
      itemId,
      field,
      oldValue,
      newValue,
      changedAt,
      kind: "change",
    };
    this.changes.push(change);
    return change;
  }

  addPhoto(itemId: number, seq: number, file?: { bytes: Uint8Array; contentType: string }): void {
    this.photos.push({
      id: this.photos.length + 1,
      itemId,
      seq,
      fileSize: file?.bytes.byteLength ?? 10,
      mimeType: file?.contentType ?? "image/png",
      collectedAt: "2026-01-01T00:00:00.000Z",
    });
    if (file) this.photoFiles.set(`${itemId}/${seq}`, file);
  }

  bookmark(itemId: number, at = "2026-01-02T00:00:00.000Z"): void {
    this.bookmarks.push({ itemId, at });
  }

  /** 담은 물건의 변동 한 건을 피드에 넣는다. */
  addFeedEntry(itemId: number, field: WatchedField, oldValue: string | null, newValue: string | null, changedAt: string): FeedEntry {
    const item = this.items.find((i) => i.id === itemId);
    const entry: FeedEntry = {
      id: this.feedEntries.length + 1,
      itemId,
      itemAddress: item?.address ?? null,
      field,
      oldValue,
      newValue,
      changedAt,
      bookmarkedAt: this.bookmarks.find((b) => b.itemId === itemId)?.at ?? "2026-01-01T00:00:00.000Z",
    };
    this.feedEntries.push(entry);
    return entry;
  }

  addRun(
    worker: WorkerKind,
    outcome: WorkerRun["outcome"] = "success",
    detail: WorkerRun["detail"] = null,
  ): WorkerRun {
    const id = this.runs.length + 1;
    const run: WorkerRun = {
      id,
      worker,
      startedAt: `2026-03-01T00:${String(id % 60).padStart(2, "0")}:00.000Z`,
      finishedAt: `2026-03-01T00:${String(id % 60).padStart(2, "0")}:05.000Z`,
      outcome,
      errorKind: null,
      errorMessage: null,
      detail,
      itemsChanged: null,
    };
    this.runs.push(run);
    return run;
  }

  // ---- 응답 ----

  private storedItem(item: AuctionItem): AuctionItem {
    return { ...item, bookmarked: this.bookmarks.some((b) => b.itemId === item.id) };
  }

  private unreadCount(): number {
    return this.feedEntries.filter((e) => this.lastReadAt === null || e.changedAt > this.lastReadAt).length;
  }

  private workerStatus(worker: WorkerKind): WorkerStatus {
    const mine = this.runs.filter((r) => r.worker === worker);
    const lastRun = mine.at(-1) ?? null;
    if (lastRun === null) return { state: "stale", lastSuccessAt: null, lastRun: null };
    const lastSuccess = [...mine].reverse().find((r) => r.outcome === "success");
    const state = lastRun.outcome === "blocked" ? "blocked" : lastRun.outcome === "failed" ? "failed" : "ok";
    return { state, lastSuccessAt: lastSuccess?.finishedAt ?? null, lastRun };
  }

  private handle(method: string, url: URL, body: unknown): Response {
    const { pathname: path, searchParams: search } = url;
    const key = `${method} ${path}`;
    const override = this.overrides.get(key);
    if (override) return override();

    if (key === "GET /api/health") return json({ status: "ok" });
    if (key === "GET /api/items") {
      const usages = search.getAll("usage");
      const analyzed = search.get("analyzed");
      let rows = this.items;
      if (usages.length > 0) rows = rows.filter((i) => usages.some((u) => i.usageType?.split(",").includes(u)));
      if (analyzed === "true") rows = rows.filter((i) => this.analyses.some((a) => a.itemId === i.id));
      if (analyzed === "false") rows = rows.filter((i) => !this.analyses.some((a) => a.itemId === i.id));
      const page = pageOf(rows, search);
      return json({ items: page.rows.map((i) => this.storedItem(i)), total: rows.length, page: page.page, pageSize: page.pageSize });
    }
    if (key === "GET /api/items/filter-options") {
      const uniq = (values: (string | null | undefined)[]) => [...new Set(values.filter((v): v is string => !!v))].sort();
      return json({
        usageTypes: uniq(this.items.flatMap((i) => i.usageType?.split(",") ?? [])),
        sidoValues: uniq(this.items.map((i) => i.sido)),
        sigunguValues: uniq(this.items.map((i) => i.sigungu)),
        courtValues: uniq(this.items.map((i) => i.court)),
      });
    }
    let m: RegExpExecArray | null;
    if (method === "GET" && (m = /^\/api\/items\/(\d+)\/analyses$/.exec(path))) {
      const id = Number(m[1]);
      if (!this.items.some((i) => i.id === id)) return json({ error: "없음" }, 404);
      const mine = this.analyses.filter((a) => a.itemId === id).sort((a, b) => b.id - a.id);
      return json({ analyses: mine.slice(0, Number(search.get("limit") ?? 10)), total: mine.length });
    }
    if (method === "GET" && (m = /^\/api\/items\/(\d+)\/changes$/.exec(path))) {
      const id = Number(m[1]);
      if (!this.items.some((i) => i.id === id)) return json({ error: "없음" }, 404);
      return json({ changes: this.changes.filter((c) => c.itemId === id) });
    }
    if (method === "GET" && (m = /^\/api\/items\/(\d+)\/photos$/.exec(path))) {
      const id = Number(m[1]);
      if (!this.items.some((i) => i.id === id)) return json({ error: "없음" }, 404);
      return json({ photos: this.photos.filter((p) => p.itemId === id) });
    }
    if (method === "GET" && (m = /^\/api\/items\/(\d+)$/.exec(path))) {
      const item = this.items.find((i) => i.id === Number(m![1]));
      return item ? json({ item: this.storedItem(item), analysis: null }) : json({ error: "없음" }, 404);
    }
    if (key === "GET /api/bookmarks") {
      const ordered = [...this.bookmarks].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : b.itemId - a.itemId));
      const items = ordered.flatMap((b) => this.items.filter((i) => i.id === b.itemId));
      const page = pageOf(items, search);
      return json({ items: page.rows.map((i) => this.storedItem(i)), total: items.length, page: page.page, pageSize: page.pageSize });
    }
    if (key === "POST /api/bookmarks") {
      const itemId = (body as { itemId?: number } | null)?.itemId;
      const item = this.items.find((i) => i.id === itemId);
      if (!item) return json({ error: "없음" }, 404);
      if (!this.bookmarks.some((b) => b.itemId === item.id)) this.bookmarks.push({ itemId: item.id, at: this.now() });
      return json({ item: { id: item.id } }, 201);
    }
    if (method === "DELETE" && (m = /^\/api\/bookmarks\/(\d+)$/.exec(path))) {
      const id = Number(m[1]);
      if (!this.items.some((i) => i.id === id)) return json({ error: "없음" }, 404);
      this.bookmarks = this.bookmarks.filter((b) => b.itemId !== id);
      return json({ itemId: id, bookmarked: false });
    }
    if (key === "GET /api/feed") {
      const ordered = [...this.feedEntries].sort((a, b) => (a.changedAt < b.changedAt ? 1 : a.changedAt > b.changedAt ? -1 : b.id - a.id));
      const page = pageOf(ordered, search);
      return json({ entries: page.rows, total: ordered.length, page: page.page, pageSize: page.pageSize, unreadCount: this.unreadCount() });
    }
    if (key === "POST /api/feed/read") {
      this.lastReadAt = this.now();
      return json({ lastReadAt: this.lastReadAt, unreadCount: this.unreadCount() });
    }
    if (key === "GET /api/worker-runs") {
      const worker = search.get("worker");
      const mine = this.runs.filter((r) => worker === null || r.worker === worker).sort((a, b) => b.id - a.id);
      const page = pageOf(mine, search);
      return json({ runs: page.rows, total: mine.length, page: page.page, pageSize: page.pageSize });
    }
    if (key === "GET /api/worker-runs/status") return json(this.workerStatus(search.get("worker") as WorkerKind));
    if (key === "GET /api/worker-runs/summary") {
      const worker = search.get("worker");
      const since = search.get("since") ?? "";
      const mine = this.runs.filter((r) => r.worker === worker && r.startedAt >= since);
      const count = (outcome: WorkerRun["outcome"]) => mine.filter((r) => r.outcome === outcome).length;
      const decided = count("success") + count("failed") + count("blocked");
      return json({
        totalRuns: mine.length,
        successCount: count("success"),
        failedCount: count("failed"),
        blockedCount: count("blocked"),
        skippedCount: count("skipped"),
        runningCount: count("running"),
        successRate: decided === 0 ? null : count("success") / decided,
        itemsChanged: mine.reduce((sum, r) => sum + (r.itemsChanged ?? 0), 0),
      });
    }
    if (key === "GET /api/collector-state/rotation") return json({ nextCourtCode: this.rotationNextCourtCode });
    if (method === "GET" && (m = /^\/api\/photos\/(\d+)\/(\d+)$/.exec(path))) {
      const itemId = Number(m[1]);
      const seq = Number(m[2]);
      const file = this.photoFiles.get(`${itemId}/${seq}`);
      if (file) {
        return new Response(file.bytes as Uint8Array<ArrayBuffer>, {
          status: 200,
          headers: { "content-type": file.contentType, "cache-control": PHOTO_CACHE_CONTROL },
        });
      }
      const recorded = this.photos.some((p) => p.itemId === itemId && p.seq === seq);
      return new Response(recorded ? "File Not Found" : "Not Found", { status: 404 });
    }
    throw new Error(`백엔드 대역이 지원하지 않는 요청: ${key}`);
  }

  readonly fetch: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    this.requests.push(requestShape(method, url.pathname, url.searchParams.keys()));
    const raw = init?.body;
    return this.handle(method, url, typeof raw === "string" ? JSON.parse(raw) : null);
  }) as typeof fetch;

  /** 이 대역에 붙은 Spring 구현체. */
  port(): DataPort {
    return createSpringPort({ baseUrl: BASE_URL, fetch: this.fetch });
  }
}

/** `describe` 안에서 부른다. 테스트마다 대역을 비우고 Spring 구현체를 포트로 끼우며, 끝나면 되돌린다. */
export function useFakeBackend(): FakeBackend {
  const backend = new FakeBackend();
  const port = backend.port();
  beforeEach(() => {
    backend.reset();
    setDataPortForTesting(port);
  });
  afterEach(() => setDataPortForTesting(null));
  return backend;
}
