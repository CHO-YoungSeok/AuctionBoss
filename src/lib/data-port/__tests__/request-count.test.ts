/**
 * 화면당 Spring 요청 수 상한(switch-web-to-data-port 5.5, design D7, spec "화면당 백엔드 요청 수 상한").
 *
 * Spring 구현체(백엔드 대역 fetch)로 화면을 그리며 보낸 요청을 센다. 상한 이하이고, 데이터 행이
 * 4건일 때와 30건일 때 같아야 한다 — 물건·회차마다 요청을 보내는 방식(N+1)이 생기면 30건 쪽이 늘어
 * 실패한다.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import * as toggle from "@/app/api/bookmarks/toggle/route";
import * as markRead from "@/app/api/feed/mark-read/route";
import * as photo from "@/app/api/photos/[itemId]/[seq]/route";
import BookmarksPage from "@/app/bookmarks/page";
import FeedPage from "@/app/feed/page";
import ItemDetailPage from "@/app/items/[id]/page";
import ItemListPage from "@/app/page";
import StatusPage from "@/app/status/page";
import type { AuctionItemInput } from "@/lib/domain";

import { setDataPortForTesting } from "../index";
import { FakeBackend } from "./fake-backend";

/** design.md D7의 화면별 상한. */
const LIMITS = { home: 6, detail: 5, bookmarks: 2, feed: 2, status: 11 } as const;
type Screen = keyof typeof LIMITS;
const ROW_COUNTS = [4, 30] as const;

/** D7: 폼 엔드포인트(관심 토글·읽음 처리)와 사진 파일은 각 1회. */
const ROUTE_LIMIT = 1;

const measured: Record<string, Record<number, number>> = {};

afterEach(() => setDataPortForTesting(null));

afterAll(() => {
  console.log(`화면별 Spring 요청 수(행 4건/30건): ${JSON.stringify(measured)}`);
});

function makeItem(n: number, overrides: Partial<AuctionItemInput> = {}): AuctionItemInput {
  return {
    court: "서울중앙지방법원",
    caseNo: `2025타경${10000 + n}`,
    itemNo: "1",
    address: `서울특별시 관악구 신림동 ${n}-1`,
    usageType: "아파트",
    appraisalPrice: 500_000_000,
    minBidPrice: 400_000_000,
    auctionDate: "2026-10-01",
    failedBidCount: 1,
    status: "진행",
    ...overrides,
  };
}

async function render(element: Promise<React.ReactElement>): Promise<string> {
  const resolved = await element;
  return renderToStaticMarkup(createElement(() => resolved));
}

function seedItems(backend: FakeBackend, rows: number): number[] {
  return Array.from({ length: rows }, (_, i) => backend.addItem(makeItem(i + 1)).id);
}

type Prepare = (backend: FakeBackend, rows: number) => number | void;

const SCREENS: Record<Screen, { prepare: Prepare; render: (id: number | void) => Promise<string> }> = {
  home: {
    prepare: (backend, rows) => void seedItems(backend, rows),
    render: () => render(ItemListPage({ searchParams: Promise.resolve({}) }) as never),
  },
  detail: {
    prepare: (backend, rows) => {
      // 분석·변경 이력·사진이 모두 `rows`건인 물건 하나(사진 상태 collected).
      const id = backend.addItem(makeItem(1, { internalCaseNo: "2025013000001", courtCode: "B000210" }), {
        photoStatus: "collected",
        photoCount: rows,
      }).id;
      for (let n = 1; n <= rows; n++) {
        backend.addAnalysis(id, { body: `분석 ${n}` });
        backend.addChange(id, "minBidPrice", String(400_000_000 - (n - 1) * 1_000_000), String(400_000_000 - n * 1_000_000), `2026-02-${String(n).padStart(2, "0")}T00:00:00.000Z`);
        backend.addPhoto(id, n);
      }
      return id;
    },
    render: (id) => render(ItemDetailPage({ params: Promise.resolve({ id: String(id) }) }) as never),
  },
  bookmarks: {
    prepare: (backend, rows) => {
      for (const id of seedItems(backend, rows)) backend.bookmark(id);
    },
    render: () => render(BookmarksPage({ searchParams: Promise.resolve({}) }) as never),
  },
  feed: {
    prepare: (backend, rows) => {
      for (const id of seedItems(backend, rows)) {
        backend.bookmark(id);
        backend.addFeedEntry(id, "minBidPrice", "400000000", "300000000", "2026-01-03T00:00:00.000Z");
      }
    },
    render: () => render(FeedPage({ searchParams: Promise.resolve({}) }) as never),
  },
  status: {
    prepare: (backend, rows) => {
      for (const worker of ["collector", "analyzer", "photos"] as const) {
        for (let n = 0; n < rows; n++) backend.addRun(worker, "success");
      }
    },
    render: () => render(StatusPage() as never),
  },
};

/** Spring 구현체로 화면을 그리고 보낸 요청 수를 돌려준다. 준비(대역 상태 넣기)는 세지 않는다. */
async function measureRender(screen: Screen, rows: number): Promise<number> {
  const backend = new FakeBackend();
  const id = SCREENS[screen].prepare(backend, rows);
  setDataPortForTesting(backend.port());
  await SCREENS[screen].render(id);
  measured[screen] ??= {};
  measured[screen][rows] = backend.requests.length;
  return backend.requests.length;
}

describe("화면당 Spring 요청 수(D7)", () => {
  it.each(Object.keys(LIMITS) as Screen[])("%s: 상한 이하이고 행 4건과 30건에서 같다", async (screen) => {
    const counts: number[] = [];
    for (const rows of ROW_COUNTS) counts.push(await measureRender(screen, rows));
    expect(counts[0]).toBeGreaterThan(0);
    expect(counts[0]).toBeLessThanOrEqual(LIMITS[screen]);
    expect(counts[1]).toBeLessThanOrEqual(LIMITS[screen]);
    expect(counts[1], "행 수가 늘어도 요청 수는 같아야 한다(N+1 금지)").toBe(counts[0]);
  });
});

describe("폼·사진 라우트당 Spring 요청 수(D7)", () => {
  const request = (url: string, fields?: Record<string, string>): Request =>
    new Request(url, fields ? { method: "POST", body: new URLSearchParams(fields) } : undefined);

  it("관심 토글(등록·해제), 읽음 처리, 사진 파일은 각각 요청 1회", async () => {
    const calls: Array<[string, (id: number) => Promise<Response>]> = [
      ["toggle 등록", (id) => toggle.POST(request("http://localhost/api/bookmarks/toggle", { itemId: String(id), bookmarked: "false", returnTo: "/" }))],
      ["toggle 해제", (id) => toggle.POST(request("http://localhost/api/bookmarks/toggle", { itemId: String(id), bookmarked: "true", returnTo: "/" }))],
      ["mark-read", () => markRead.POST(request("http://localhost/api/feed/mark-read", { returnTo: "/feed" }))],
      ["photo", (id) => photo.GET(request(`http://localhost/api/photos/${id}/1`) as never, { params: Promise.resolve({ itemId: String(id), seq: "1" }) })],
    ];
    for (const [name, call] of calls) {
      const backend = new FakeBackend();
      const [id] = seedItems(backend, 3);
      backend.addPhoto(id, 1, { bytes: new Uint8Array([1]), contentType: "image/png" });
      setDataPortForTesting(backend.port());
      const response = await call(id);
      expect([200, 303], name).toContain(response.status);
      expect(backend.requests.length, name).toBe(ROUTE_LIMIT);
    }
  });
});
