/**
 * SQLite 구현체 단위 테스트(switch-web-to-data-port 2.1). 임시 SQLite 파일 하나에 저장소 함수로
 * 데이터를 넣고 포트 메서드가 같은 값을 돌려주는지 본다.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  closeDb,
  createBookmarksRepository,
  createCollectorStateRepository,
  createRepository,
  createWorkerRunsRepository,
  openDatabase,
  type Db,
} from "@/lib/db";
import { ItemNotFoundError, type AuctionItemInput } from "@/lib/domain";

import type { DataPort } from "../port";
import { createSqlitePort } from "../sqlite";

let workDir: string;
let db: Db;
let port: DataPort;
let originalDbEnv: string | undefined;

beforeEach(() => {
  workDir = mkdtempSync(path.join(tmpdir(), "auctionboss-port-sqlite-"));
  originalDbEnv = process.env.AUCTIONBOSS_DB;
  // 사진 파일은 DB 파일 옆 `photos/`에 있다(`getPhotosDir`).
  process.env.AUCTIONBOSS_DB = path.join(workDir, "test.db");
  closeDb();
  db = openDatabase(":memory:");
  port = createSqlitePort(db);
});

afterEach(() => {
  db.close();
  closeDb();
  if (originalDbEnv === undefined) delete process.env.AUCTIONBOSS_DB;
  else process.env.AUCTIONBOSS_DB = originalDbEnv;
  rmSync(workDir, { recursive: true, force: true });
});

function makeItem(overrides: Partial<AuctionItemInput> = {}): AuctionItemInput {
  return {
    court: "서울중앙지방법원",
    caseNo: "2025타경12345",
    itemNo: "1",
    address: "서울특별시 관악구 신림동 1-1",
    usageType: "아파트",
    appraisalPrice: 500_000_000,
    minBidPrice: 400_000_000,
    auctionDate: "2026-10-01",
    failedBidCount: 1,
    status: "진행",
    ...overrides,
  };
}

function seedItem(overrides: Partial<AuctionItemInput> = {}): number {
  const item = makeItem(overrides);
  createRepository(db).upsertItems([item], { now: "2026-01-01T00:00:00.000Z" });
  const found = createRepository(db)
    .listItems({ pageSize: 200 })
    .items.find((i) => i.caseNo === item.caseNo && i.itemNo === item.itemNo);
  if (!found) throw new Error("seedItem 실패");
  return found.id;
}

describe("sqlite 포트 — 읽기", () => {
  it("listItems와 getItemById는 저장소 결과를 그대로 돌려준다", async () => {
    const id = seedItem();
    const list = await port.listItems({ pageSize: 1 });
    expect(list).toStrictEqual(createRepository(db).listItems({ pageSize: 1 }));
    expect(list.total).toBe(1);
    expect(await port.getItemById(id)).toStrictEqual(createRepository(db).getItemById(id));
    expect(await port.getItemById(9999)).toBeNull();
  });

  it("listFilterOptions는 저장된 값에서 네 가지 선택지를 도출한다", async () => {
    seedItem({ court: "서울동부지방법원", usageType: "상가,오피스텔", sido: "서울특별시", sigungu: "관악구" });
    seedItem({ caseNo: "2025타경2", usageType: "아파트", court: "서울중앙지방법원", sido: "서울특별시", sigungu: "강남구" });
    expect(await port.listFilterOptions()).toStrictEqual({
      usageTypes: ["상가", "아파트", "오피스텔"],
      sidoValues: ["서울특별시"],
      sigunguValues: ["강남구", "관악구"],
      courtValues: ["서울동부지방법원", "서울중앙지방법원"],
    });
  });

  it("getAnalysisHistory는 limit만큼만 최신순으로 주고 total은 잘리지 않는다", async () => {
    const id = seedItem();
    const repo = createRepository(db);
    for (let i = 1; i <= 5; i++) {
      repo.insertAnalysis(
        { itemId: id, body: `본문 ${i}`, model: null, promptVersion: "v1" },
        { now: `2026-02-0${i}T00:00:00.000Z` },
      );
    }
    const history = await port.getAnalysisHistory(id, { limit: 3 });
    expect(history.total).toBe(5);
    expect(history.analyses.map((a) => a.body)).toStrictEqual(["본문 5", "본문 4", "본문 3"]);
    expect(await port.getAnalysisHistory(id, { limit: 11 })).toMatchObject({ total: 5 });
  });

  it("getAnalysisHistory는 분석이 없거나 없는 물건이면 빈 이력이다", async () => {
    const id = seedItem();
    expect(await port.getAnalysisHistory(id, { limit: 11 })).toStrictEqual({ analyses: [], total: 0 });
    expect(await port.getAnalysisHistory(9999, { limit: 11 })).toStrictEqual({ analyses: [], total: 0 });
  });

  it("listItemChanges는 저장소 결과를 돌려주고 없는 물건은 빈 배열이다", async () => {
    const id = seedItem();
    expect(await port.listItemChanges(id)).toStrictEqual(createRepository(db).listItemChanges(id));
    expect(await port.listItemChanges(9999)).toStrictEqual([]);
  });

  it("listItemPhotos는 filePath를 뺀 메타만 돌려준다", async () => {
    const id = seedItem();
    createRepository(db).saveItemPhotos(
      id,
      [
        { seq: 1, filePath: "1/1.jpg", fileSize: 10, mimeType: "image/jpeg" },
        { seq: 2, filePath: "1/2.png", fileSize: 20, mimeType: "image/png" },
      ],
      "collected",
      { now: "2026-03-01T00:00:00.000Z" },
    );
    const photos = await port.listItemPhotos(id);
    expect(photos).toHaveLength(2);
    expect(photos.map((p) => p.seq)).toStrictEqual([1, 2]);
    for (const photo of photos) {
      expect(Object.keys(photo).sort()).toStrictEqual(["collectedAt", "fileSize", "id", "itemId", "mimeType", "seq"]);
      expect(photo).not.toHaveProperty("filePath");
    }
    expect(await port.listItemPhotos(9999)).toStrictEqual([]);
  });

  it("관심·피드·미확인 개수는 저장소 결과와 같다", async () => {
    const id = seedItem();
    createBookmarksRepository(db).addBookmark(id, { now: "2026-03-01T00:00:00.000Z" });
    expect(await port.listBookmarkedItems({ page: 1 })).toStrictEqual(
      createBookmarksRepository(db).listBookmarkedItems({ page: 1 }),
    );
    expect(await port.listFeed({ page: 1 })).toStrictEqual(createBookmarksRepository(db).listFeed({ page: 1 }));
    expect(await port.getUnreadCount()).toBe(createBookmarksRepository(db).getUnreadCount());
  });

  it("getWorkerStatus는 주입한 now로 판정하고, listWorkerRuns·summarizeRuns는 저장소 결과와 같다", async () => {
    const runs = createWorkerRunsRepository(db);
    const runId = runs.startRun("collector", { now: "2026-03-01T00:00:00.000Z" });
    runs.finishRun(runId, { outcome: "success" }, { now: "2026-03-01T00:01:00.000Z" });

    const fresh = createSqlitePort(db, { now: () => new Date("2026-03-01T00:05:00.000Z") });
    expect((await fresh.getWorkerStatus("collector")).state).toBe("ok");
    const late = createSqlitePort(db, { now: () => new Date("2026-04-01T00:00:00.000Z") });
    expect((await late.getWorkerStatus("collector")).state).toBe("stale");

    expect(await port.listWorkerRuns({ worker: "collector", pageSize: 20 })).toStrictEqual(
      runs.listWorkerRuns({ worker: "collector", pageSize: 20 }),
    );
    expect(await port.summarizeRuns({ worker: "collector", since: "2026-02-01T00:00:00.000Z" })).toStrictEqual(
      runs.summarizeRuns({ worker: "collector", since: "2026-02-01T00:00:00.000Z" }),
    );
  });

  it("getRotationNextCourtCode는 기록이 없으면 null, 있으면 값이다", async () => {
    expect(await port.getRotationNextCourtCode()).toBeNull();
    createCollectorStateRepository(db).setCollectorState("collector.rotation.nextCourtCode", "B000211");
    expect(await port.getRotationNextCourtCode()).toBe("B000211");
  });
});

describe("sqlite 포트 — 쓰기", () => {
  it("없는 물건 관심 등록·해제는 ItemNotFoundError다", async () => {
    await expect(port.addBookmark(9999)).rejects.toBeInstanceOf(ItemNotFoundError);
    await expect(port.removeBookmark(9999)).rejects.toBeInstanceOf(ItemNotFoundError);
  });

  it("등록은 중복이어도 오류가 아니고 해제 후 목록에서 빠진다", async () => {
    const id = seedItem();
    await port.addBookmark(id);
    await port.addBookmark(id);
    expect((await port.listBookmarkedItems({ page: 1 })).total).toBe(1);
    await port.removeBookmark(id);
    await port.removeBookmark(id);
    expect((await port.listBookmarkedItems({ page: 1 })).total).toBe(0);
  });

  it("markFeedRead는 미확인 개수를 0으로 만든다", async () => {
    const id = seedItem();
    createRepository(db).upsertItems([makeItem({ minBidPrice: 300_000_000 })], {
      now: "2026-01-02T00:00:00.000Z",
    });
    await port.addBookmark(id);
    // 관심 등록 이전 변동이 피드에 포함되므로 미확인이 있다.
    expect(await port.getUnreadCount()).toBeGreaterThan(0);
    await port.markFeedRead();
    expect(await port.getUnreadCount()).toBe(0);
  });
});

describe("sqlite 포트 — 사진 파일", () => {
  function writePhoto(relative: string, content: Buffer): void {
    const file = path.join(workDir, "photos", relative);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
  }

  it("기록과 파일이 있으면 200, 본문·Content-Type·Cache-Control을 돌려준다", async () => {
    const id = seedItem();
    createRepository(db).saveItemPhotos(
      id,
      [{ seq: 1, filePath: `${id}/1.jpg`, fileSize: 3, mimeType: "image/jpeg" }],
      "collected",
    );
    writePhoto(`${id}/1.jpg`, Buffer.from([0xff, 0xd8, 0xff]));
    const result = await port.getPhotoFile(id, 1);
    expect(result).toStrictEqual({
      status: 200,
      body: new Uint8Array([0xff, 0xd8, 0xff]),
      contentType: "image/jpeg",
      cacheControl: "public, max-age=86400, immutable",
    });
  });

  it("사진 기록이 없으면 Not Found, 기록은 있는데 파일이 없으면 File Not Found로 구분한다", async () => {
    const id = seedItem();
    createRepository(db).saveItemPhotos(
      id,
      [{ seq: 1, filePath: `${id}/1.jpg`, fileSize: 3, mimeType: "image/jpeg" }],
      "collected",
    );
    expect(await port.getPhotoFile(id, 2)).toStrictEqual({ status: 404, message: "Not Found" });
    expect(await port.getPhotoFile(9999, 1)).toStrictEqual({ status: 404, message: "Not Found" });
    expect(await port.getPhotoFile(id, 1)).toStrictEqual({ status: 404, message: "File Not Found" });
  });
});
