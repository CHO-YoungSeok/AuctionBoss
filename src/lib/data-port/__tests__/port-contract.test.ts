/**
 * 포트 계약 테스트(switch-web-to-data-port 5.2~5.3, design D6 ②).
 *
 * 시드를 적재한 임시 SQLite 하나에 대해 SQLite 구현체와 "Next 핸들러 대역 fetch"를 쓴 Spring 구현체를
 * 나란히 만들어 같은 호출의 결과를 `toStrictEqual`로 비교한다. Spring 구현체의 직렬화·zod·변환은
 * 여기서, Spring이 Next 핸들러와 같다는 것은 골든(`ScenarioContractTest`)이 증명한다. 마지막 검사는
 * 두 증명 사이의 빈틈을 막는다: Spring 구현체가 보낸 요청 틀이 모두 커밋된 골든에 있어야 한다.
 */
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { withFixedNow } from "../../../../scripts/seed/fixed-clock";
import { seedToSqlite } from "../../../../scripts/seed/seed-to-sqlite";
import { closeDb, finishRun, getDb, startRun } from "@/lib/db";
import { ItemNotFoundError, WORKER_KINDS, type ItemQuery } from "@/lib/domain";

import type { DataPort } from "../port";
import { createSpringPort } from "../spring/port";
import { createSqlitePort } from "../sqlite";
import { loadGoldenShapes, CONTRACTS_DIR } from "./golden-shapes";
import { createNextStandIn, shapeKey } from "./next-stand-in";

let workDir: string;
let baseDb: string;
let savedDb: string | undefined;
const standIn = createNextStandIn();

const sqlite: DataPort = createSqlitePort();
const spring: DataPort = createSpringPort({ baseUrl: "http://spring.test", fetch: standIn.fetch });

/** 사례 수(보고용). */
const counts: Record<string, number> = {};
function count(kind: string): void {
  counts[kind] = (counts[kind] ?? 0) + 1;
}

/**
 * `undefined` 값 키를 지운 사본. SQLite 쪽 객체는 계산하지 않은 선택 필드를 `undefined`로 갖고 있고
 * (`photoCount` 등), HTTP/JSON을 거친 쪽에는 키가 없다 — 화면에는 같은 값이다.
 */
function stripUndefined(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripUndefined);
  if (value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => [k, stripUndefined(v)]),
    );
  }
  return value;
}

/** 두 구현체에 같은 호출을 하고 결과가 같은지 본다. 같은 값을 돌려준다. */
async function same<T>(kind: string, call: (port: DataPort) => Promise<T>): Promise<T> {
  count(kind);
  const [a, b] = await Promise.all([call(sqlite), call(spring)]);
  expect(stripUndefined(b)).toStrictEqual(stripUndefined(a));
  return a;
}

function switchDb(file: string): void {
  closeDb();
  process.env.AUCTIONBOSS_DB = file;
}

/** 시드 DB의 새 복사본에서 `fn`을 돈다. 쓰기 사례가 서로 섞이지 않게 한다. */
let copySeq = 0;
function withFreshDb<T>(fn: () => Promise<T>): Promise<T> {
  const file = path.join(workDir, `fresh-${copySeq++}.db`);
  copyFileSync(baseDb, file);
  switchDb(file);
  return fn();
}

beforeAll(() => {
  savedDb = process.env.AUCTIONBOSS_DB;
  workDir = mkdtempSync(path.join(tmpdir(), "auctionboss-port-contract-"));
  baseDb = path.join(workDir, "base.db");
  seedToSqlite(baseDb);
  // 사진 사례: 물건 1에 2건(파일 있음), 물건 1의 3번은 파일 없음.
  const photosDir = path.join(workDir, "photos", "1");
  mkdirSync(photosDir, { recursive: true });
  copyFileSync(path.join(CONTRACTS_DIR, "photos/sample.png"), path.join(photosDir, "1.png"));
  copyFileSync(path.join(CONTRACTS_DIR, "photos/sample.jpg"), path.join(photosDir, "2.jpg"));
  switchDb(baseDb);
  const db = getDb();
  const insert = db.prepare(
    "INSERT INTO item_photos (item_id, seq, file_path, file_size, mime_type, collected_at) VALUES (?, ?, ?, ?, ?, ?)",
  );
  insert.run(1, 1, "1/1.png", 70, "image/png", "2026-10-07T00:00:00.000Z");
  insert.run(1, 2, "1/2.jpg", 22, "image/jpeg", "2026-10-07T00:00:00.000Z");
  insert.run(1, 3, "1/3.png", 70, "image/png", "2026-10-07T00:00:00.000Z");
  finishRun(startRun("photos"), { outcome: "success" });
  // 수집 워커 회차 하나(정상 판정 사례). 시각은 실제 지금이다 — 두 구현체가 같은 DB를 같은 순간에 읽는다.
  const id = startRun("collector");
  finishRun(id, { outcome: "success", detail: { targetCourts: ["서울중앙지방법원"], pagesRequested: 1, itemsFetched: 1, inserted: 0, updated: 1, changed: 0 } });
  // 베이스 DB 파일에 반영(쓰기 모드 WAL이면 체크포인트).
  db.pragma("wal_checkpoint(TRUNCATE)");
  closeDb();
});

beforeEach(() => {
  switchDb(baseDb);
});

afterAll(() => {
  closeDb();
  if (savedDb === undefined) delete process.env.AUCTIONBOSS_DB;
  else process.env.AUCTIONBOSS_DB = savedDb;
  rmSync(workDir, { recursive: true, force: true });
});

const LIST_QUERIES: [string, ItemQuery][] = [
  ["기본", {}],
  ["2페이지·페이지 크기 5", { page: 2, pageSize: 5 }],
  ...(["auctionDate", "minBidPrice", "bidRatio", "failedBidCount", "pricePerArea"] as const).flatMap(
    (sort) =>
      (["asc", "desc"] as const).map((direction): [string, ItemQuery] => [
        `정렬 ${sort} ${direction}`,
        { sort, direction, pageSize: 10 },
      ]),
  ),
  ["용도 여러 개", { usageTypes: ["아파트", "오피스텔"], pageSize: 10 }],
  ["시도·시군구", { sidoValues: ["서울특별시"], sigunguValues: ["성북구", "관악구"], pageSize: 50 }],
  ["가격 범위", { minPrice: 100_000_000, maxPrice: 600_000_000, pageSize: 10 }],
  ["유찰 횟수 하한", { minFailedBidCount: 2, pageSize: 10 }],
  ["주소 검색어", { addressKeyword: "정릉" }],
  ["분석된 물건만(건수용)", { analyzed: true, pageSize: 1 }],
  ["전체 건수용", { pageSize: 1 }],
  ["저감률", { minDiscountRate: 30, pageSize: 50 }],
  ["사진 보유", { hasPhotos: true }],
  ["비어 있는 결과", { addressKeyword: "존재하지않는소재지키워드" }],
];

describe("포트 계약: 읽기", () => {
  it.each(LIST_QUERIES)("listItems: %s", async (_name, query) => {
    const result = await same("listItems", (p) => p.listItems(query));
    expect(result.pageSize).toBeGreaterThan(0);
  });

  it("listItems: 사례가 비어 있지 않은 결과를 실제로 비교한다", async () => {
    const result = await same("listItems", (p) => p.listItems({ pageSize: 5 }));
    expect(result.items.length).toBe(5);
    expect(result.total).toBeGreaterThan(5);
  });

  it.each([1, 207, 999_999])("getItemById: %i", async (id) => {
    const item = await same("getItemById", (p) => p.getItemById(id));
    expect(item === null).toBe(id === 999_999);
  });

  it("listFilterOptions", async () => {
    const options = await same("listFilterOptions", (p) => p.listFilterOptions());
    expect(options.usageTypes.length).toBeGreaterThan(0);
  });

  it.each([
    [1, 11],
    [1, 1],
    [207, 11],
    [999_999, 11],
  ])("getAnalysisHistory: 물건 %i limit %i", async (id, limit) => {
    const history = await same("getAnalysisHistory", (p) => p.getAnalysisHistory(id, { limit }));
    if (id === 1 && limit === 1) expect(history.analyses).toHaveLength(1);
    if (id === 207) expect(history).toEqual({ analyses: [], total: 0 });
  });

  it.each([1, 2, 999_999])("listItemChanges: 물건 %i", async (id) => {
    const changes = await same("listItemChanges", (p) => p.listItemChanges(id));
    expect(changes.length > 0).toBe(id !== 999_999);
  });

  it.each([
    [1, 3],
    [2, 0],
    [999_999, 0],
  ])("listItemPhotos: 물건 %i", async (id, expected) => {
    const photos = await same("listItemPhotos", (p) => p.listItemPhotos(id));
    expect(photos).toHaveLength(expected);
    expect(photos.every((photo) => !("filePath" in photo))).toBe(true);
  });

  it.each([
    [1, 1, 200],
    [1, 2, 200],
    [1, 3, 404], // 기록은 있으나 파일 없음
    [1, 9, 404], // 기록 없음
  ])("getPhotoFile: 물건 %i 사진 %i", async (id, seq, status) => {
    const file = await same("getPhotoFile", (p) => p.getPhotoFile(id, seq));
    expect(file.status).toBe(status);
    if (file.status !== 200) expect(file.message).toBe(seq === 3 ? "File Not Found" : "Not Found");
  });

  it("getUnreadCount, 빈 관심 목록·피드", async () => {
    await same("getUnreadCount", (p) => p.getUnreadCount());
    const bookmarks = await same("listBookmarkedItems", (p) => p.listBookmarkedItems({ page: 1 }));
    expect(bookmarks.total).toBe(0);
    await same("listFeed", (p) => p.listFeed({ page: 1 }));
  });

  it.each(WORKER_KINDS)("워커 %s: 상태·집계·회차", async (worker) => {
    const status = await same("getWorkerStatus", (p) => p.getWorkerStatus(worker));
    if (worker === "collector") expect(status.state).toBe("ok");
    await same("summarizeRuns", (p) => p.summarizeRuns({ worker, since: "2026-01-01T00:00:00.000Z" }));
    const runs = await same("listWorkerRuns", (p) => p.listWorkerRuns({ worker, pageSize: 20 }));
    expect(runs.runs.length).toBeGreaterThan(0);
  });

  it("getRotationNextCourtCode(시드의 기록, 그리고 기록 없음)", async () => {
    expect(await same("getRotationNextCourtCode", (p) => p.getRotationNextCourtCode())).toBe("B000211");
    await withFreshDb(async () => {
      getDb().prepare("DELETE FROM collector_state").run();
      expect(await same("getRotationNextCourtCode", (p) => p.getRotationNextCourtCode())).toBeNull();
    });
  });
});

describe("포트 계약: 쓰기 후 읽기", () => {
  /** 한 구현체로 쓰기 시퀀스를 돌리고 뒤따르는 읽기 결과를 모은다. 시각은 고정해 두 실행이 같다. */
  async function sequence(port: DataPort) {
    return withFreshDb(() =>
      withFixedNow("2026-10-08T00:00:00.000Z", async () => {
        const out: Record<string, unknown> = {};
        out.unreadBefore = await port.getUnreadCount();
        await port.addBookmark(1);
        await port.addBookmark(3);
        await port.addBookmark(1); // 중복은 조용히 무시
        out.bookmarks = await port.listBookmarkedItems({ page: 1 });
        out.bookmarks2 = await port.listBookmarkedItems({ page: 2 });
        out.feed = await port.listFeed({ page: 1 });
        out.unreadAfterAdd = await port.getUnreadCount();
        await port.removeBookmark(3);
        out.bookmarksAfterRemove = await port.listBookmarkedItems({ page: 1 });
        out.detail = await port.getItemById(1);
        await port.markFeedRead();
        out.unreadAfterRead = await port.getUnreadCount();
        out.feedAfterRead = await port.listFeed({ page: 1 });
        out.notFound = await Promise.all([
          port.addBookmark(999_999).catch((e: unknown) => e),
          port.removeBookmark(999_999).catch((e: unknown) => e),
        ]);
        return out;
      }),
    );
  }

  it("관심 2건 등록, 1건 해제, 읽음 처리 뒤 관심 목록·피드·미확인이 같다", async () => {
    const fromSqlite = await sequence(sqlite);
    const fromSpring = await sequence(spring);
    count("write-sequence");
    expect(stripUndefined(fromSpring)).toStrictEqual(stripUndefined(fromSqlite));
    // 비교가 비어 있지 않음.
    expect((fromSqlite.bookmarks as { total: number }).total).toBe(2);
    expect((fromSqlite.bookmarksAfterRemove as { total: number }).total).toBe(1);
    expect(fromSqlite.unreadAfterRead).toBe(0);
    for (const error of fromSqlite.notFound as unknown[]) expect(error).toBeInstanceOf(ItemNotFoundError);
    for (const error of fromSpring.notFound as unknown[]) expect(error).toBeInstanceOf(ItemNotFoundError);
  });
});

describe("포트 계약: 골든 포함 검사", () => {
  it("Spring 구현체가 보낸 요청 틀이 모두 커밋된 골든에 있다", () => {
    const golden = loadGoldenShapes();
    const used = new Set(standIn.requests.map(shapeKey));
    expect(used.size).toBeGreaterThan(10);
    const missing = [...used].filter((key) => !golden.has(key)).sort();
    expect(missing, "골든에 없는 요청 틀 — scripts/seed/scenarios.ts에 단계를 추가하고 재생성하세요").toEqual([]);
  });

  it("사례 수를 기록한다", () => {
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    console.log(`포트 계약 사례 ${total}건`, JSON.stringify(counts));
    expect(total).toBeGreaterThan(50);
  });
});
