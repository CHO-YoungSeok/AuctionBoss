/**
 * 화면당 Spring 요청 수 상한(switch-web-to-data-port 5.5, design D7, spec "화면당 백엔드 요청 수 상한").
 *
 * Spring 구현체(Next 핸들러 대역 fetch)로 화면을 그리며 보낸 요청을 센다. 상한 이하이고, 데이터 행이
 * 4건일 때와 30건일 때 같아야 한다 — 물건·회차마다 요청을 보내는 방식(N+1)이 생기면 30건 쪽이 늘어
 * 실패한다.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import * as toggle from "@/app/api/bookmarks/toggle/route";
import * as markRead from "@/app/api/feed/mark-read/route";
import * as photo from "@/app/api/photos/[itemId]/[seq]/route";
import BookmarksPage from "@/app/bookmarks/page";
import FeedPage from "@/app/feed/page";
import ItemDetailPage from "@/app/items/[id]/page";
import ItemListPage from "@/app/page";
import StatusPage from "@/app/status/page";
import { addBookmark, closeDb, finishRun, getDb, getRepository, startRun } from "@/lib/db";
import type { AuctionItemInput } from "@/lib/domain";

import { setDataPortForTesting } from "../index";
import { createTestPort } from "./data-sources";

/** design.md D7의 화면별 상한. */
const LIMITS = { home: 6, detail: 5, bookmarks: 2, feed: 2, status: 11 } as const;
type Screen = keyof typeof LIMITS;
const ROW_COUNTS = [4, 30] as const;

/** D7: 폼 엔드포인트(관심 토글·읽음 처리)와 사진 파일은 각 1회. */
const ROUTE_LIMIT = 1;

const measured: Record<string, Record<number, number>> = {};

let workDir: string;
let originalDbEnv: string | undefined;

beforeEach(() => {
  workDir = mkdtempSync(path.join(tmpdir(), "auctionboss-request-count-"));
  originalDbEnv = process.env.AUCTIONBOSS_DB;
  closeDb();
});

afterEach(() => {
  setDataPortForTesting(null);
  closeDb();
  if (originalDbEnv === undefined) delete process.env.AUCTIONBOSS_DB;
  else process.env.AUCTIONBOSS_DB = originalDbEnv;
  rmSync(workDir, { recursive: true, force: true });
});

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

/** 새 임시 DB로 바꾼다. */
let dbSeq = 0;
function switchToFreshDb(): void {
  closeDb();
  process.env.AUCTIONBOSS_DB = path.join(workDir, `db-${dbSeq++}.db`);
}

async function render(element: Promise<React.ReactElement>): Promise<string> {
  const resolved = await element;
  return renderToStaticMarkup(createElement(() => resolved));
}

function seedItems(rows: number): number[] {
  const repo = getRepository();
  repo.upsertItems(Array.from({ length: rows }, (_, i) => makeItem(i + 1)), { now: "2026-01-01T00:00:00.000Z" });
  return repo.listItems({ pageSize: 200 }).items.map((i) => i.id);
}

type Prepare = (rows: number) => number | void;

const SCREENS: Record<Screen, { prepare: Prepare; render: (id: number | void) => Promise<string> }> = {
  home: {
    prepare: (rows) => void seedItems(rows),
    render: () => render(ItemListPage({ searchParams: Promise.resolve({}) }) as never),
  },
  detail: {
    prepare: (rows) => {
      // 분석·변경 이력·사진이 모두 `rows`건인 물건 하나(사진 상태 collected).
      const repo = getRepository();
      repo.upsertItems([makeItem(1, { internalCaseNo: "2025013000001", courtCode: "B000210" })], {
        now: "2026-01-01T00:00:00.000Z",
      });
      const id = repo.listItems().items[0].id;
      for (let n = 1; n <= rows; n++) {
        repo.insertAnalysis({ itemId: id, body: `분석 ${n}`, model: null, promptVersion: "v3" });
        repo.upsertItems([makeItem(1, { minBidPrice: 400_000_000 - n * 1_000_000 })], {
          now: `2026-02-${String(n).padStart(2, "0")}T00:00:00.000Z`,
        });
        getDb()
          .prepare(
            "INSERT INTO item_photos (item_id, seq, file_path, file_size, mime_type, collected_at) VALUES (?, ?, ?, 10, 'image/png', '2026-01-01T00:00:00.000Z')",
          )
          .run(id, n, `${id}/${n}.png`);
      }
      getDb().prepare("UPDATE items SET photo_status = 'collected', photo_count = ? WHERE id = ?").run(rows, id);
      return id;
    },
    render: (id) => render(ItemDetailPage({ params: Promise.resolve({ id: String(id) }) }) as never),
  },
  bookmarks: {
    prepare: (rows) => {
      for (const id of seedItems(rows)) addBookmark(id, { now: "2026-01-02T00:00:00.000Z" });
    },
    render: () => render(BookmarksPage({ searchParams: Promise.resolve({}) }) as never),
  },
  feed: {
    prepare: (rows) => {
      const ids = seedItems(rows);
      for (const id of ids) addBookmark(id, { now: "2026-01-02T00:00:00.000Z" });
      // 담은 물건마다 가격이 바뀐 변동 `rows`건.
      getRepository().upsertItems(
        ids.map((_, i) => makeItem(i + 1, { minBidPrice: 300_000_000 })),
        { now: "2026-01-03T00:00:00.000Z" },
      );
    },
    render: () => render(FeedPage({ searchParams: Promise.resolve({}) }) as never),
  },
  status: {
    prepare: (rows) => {
      for (const worker of ["collector", "analyzer", "photos"] as const) {
        for (let n = 0; n < rows; n++) finishRun(startRun(worker), { outcome: "success" });
      }
    },
    render: () => render(StatusPage() as never),
  },
};

/** Spring 구현체로 화면을 그리고 보낸 요청 수를 돌려준다. 준비(SQLite 직접 쓰기)는 세지 않는다. */
async function measureRender(screen: Screen, rows: number, id: number | void): Promise<number> {
  const { port, sent } = createTestPort("spring");
  setDataPortForTesting(port);
  await SCREENS[screen].render(id);
  measured[screen] ??= {};
  measured[screen][rows] = sent.length;
  return sent.length;
}

describe("화면당 Spring 요청 수(D7)", () => {
  it.each(Object.keys(LIMITS) as Screen[])("%s: 상한 이하이고 행 4건과 30건에서 같다", async (screen) => {
    const counts: number[] = [];
    for (const rows of ROW_COUNTS) {
      switchToFreshDb();
      const id = SCREENS[screen].prepare(rows);
      counts.push(await measureRender(screen, rows, id));
    }
    expect(counts[0]).toBeGreaterThan(0);
    expect(counts[0]).toBeLessThanOrEqual(LIMITS[screen]);
    expect(counts[1]).toBeLessThanOrEqual(LIMITS[screen]);
    expect(counts[1], "행 수가 늘어도 요청 수는 같아야 한다(N+1 금지)").toBe(counts[0]);
  });
});

describe("폼·사진 라우트당 Spring 요청 수(D7)", () => {
  const request = (url: string, fields?: Record<string, string>): Request =>
    new Request(url, fields ? { method: "POST", body: new URLSearchParams(fields) } : undefined);

  beforeEach(() => switchToFreshDb());

  it("관심 토글(등록·해제), 읽음 처리, 사진 파일은 각각 요청 1회", async () => {
    const [id] = seedItems(3);
    const photosDir = path.join(workDir, "photos", "1");
    mkdirSync(photosDir, { recursive: true });
    writeFileSync(path.join(photosDir, "1.png"), "x");
    getDb()
      .prepare("INSERT INTO item_photos (item_id, seq, file_path, file_size, mime_type, collected_at) VALUES (?, 1, '1/1.png', 1, 'image/png', '2026-01-01T00:00:00.000Z')")
      .run(id);

    const calls: Array<[string, () => Promise<Response>]> = [
      ["toggle 등록", () => toggle.POST(request("http://localhost/api/bookmarks/toggle", { itemId: String(id), bookmarked: "false", returnTo: "/" }))],
      ["toggle 해제", () => toggle.POST(request("http://localhost/api/bookmarks/toggle", { itemId: String(id), bookmarked: "true", returnTo: "/" }))],
      ["mark-read", () => markRead.POST(request("http://localhost/api/feed/mark-read", { returnTo: "/feed" }))],
      ["photo", () => photo.GET(request(`http://localhost/api/photos/${id}/1`) as never, { params: Promise.resolve({ itemId: String(id), seq: "1" }) })],
    ];
    for (const [name, call] of calls) {
      const { port, sent } = createTestPort("spring");
      setDataPortForTesting(port);
      const response = await call();
      expect([200, 303], name).toContain(response.status);
      expect(sent.length, name).toBe(ROUTE_LIMIT);
    }
  });
});
