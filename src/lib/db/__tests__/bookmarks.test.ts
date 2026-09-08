import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AuctionItemInput } from "@/lib/domain";

import { openDatabase, type Db } from "../client";
import { ItemNotFoundError } from "../errors";
import { createBookmarksRepository, type BookmarksRepository } from "../bookmarks";
import { createRepository, type AuctionRepository } from "../repository";

/**
 * bookmarks/feed_reads 저장소 테스트(add-bookmarks-and-feed task 1.3~1.6).
 *
 * 모든 테스트는 인메모리 DB를 쓴다 — repository.test.ts와 같은 관례.
 */
let db: Db;
let items: AuctionRepository;
let bookmarks: BookmarksRepository;

beforeEach(() => {
  db = openDatabase(":memory:");
  items = createRepository(db);
  bookmarks = createBookmarksRepository(db);
});

afterEach(() => {
  db.close();
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

/** 물건 하나를 만들고 id를 돌려준다. */
function seedItem(overrides: Partial<AuctionItemInput> = {}, now = "2026-01-01T00:00:00.000Z") {
  const item = makeItem(overrides);
  items.upsertItems([item], { now });
  // listItems()[0]은 정렬 기준(매각기일→id) 때문에 "방금 만든 물건"과 다를 수 있다 —
  // 자연 키(caseNo/itemNo)로 정확히 찾는다.
  const found = items
    .listItems({ pageSize: 200 })
    .items.find((i) => i.caseNo === item.caseNo && i.itemNo === item.itemNo);
  if (!found) throw new Error("seedItem: 방금 저장한 물건을 찾지 못했습니다");
  return found.id;
}

describe("addBookmark / removeBookmark / isBookmarked", () => {
  it("물건을 관심 목록에 담으면 isBookmarked가 true가 되고 목록에 나타난다", () => {
    const itemId = seedItem();

    bookmarks.addBookmark(itemId, { now: "2026-01-02T00:00:00.000Z" });

    expect(bookmarks.isBookmarked(itemId)).toBe(true);
    const { items: listed, total } = bookmarks.listBookmarkedItems();
    expect(total).toBe(1);
    expect(listed[0]?.id).toBe(itemId);
  });

  it("이미 담긴 물건을 다시 담아도 중복 행이 생기지 않고 오류도 나지 않는다", () => {
    const itemId = seedItem();

    bookmarks.addBookmark(itemId, { now: "2026-01-02T00:00:00.000Z" });
    expect(() => bookmarks.addBookmark(itemId, { now: "2026-01-03T00:00:00.000Z" })).not.toThrow();

    expect(bookmarks.listBookmarkedItems().total).toBe(1);
  });

  it("존재하지 않는 물건은 담을 수 없다(ItemNotFoundError)", () => {
    expect(() => bookmarks.addBookmark(999)).toThrow(ItemNotFoundError);
    expect(bookmarks.listBookmarkedItems().total).toBe(0);
  });

  it("담긴 물건을 관심 목록에서 빼면 목록에서 사라진다", () => {
    const itemId = seedItem();
    bookmarks.addBookmark(itemId);

    bookmarks.removeBookmark(itemId);

    expect(bookmarks.isBookmarked(itemId)).toBe(false);
    expect(bookmarks.listBookmarkedItems().total).toBe(0);
  });

  it("담기지 않은(존재하는) 물건을 해제해도 오류가 아니다(idempotent)", () => {
    const itemId = seedItem();
    expect(() => bookmarks.removeBookmark(itemId)).not.toThrow();
  });

  it("존재하지 않는 물건의 해제는 ItemNotFoundError다", () => {
    expect(() => bookmarks.removeBookmark(999)).toThrow(ItemNotFoundError);
  });

  it("관심 물건이 없으면 목록은 빈 배열이다(오류 아님)", () => {
    expect(bookmarks.listBookmarkedItems()).toEqual({ items: [], total: 0, page: 1, pageSize: 20 });
  });
});

describe("listFeed — kind='change'만 포함(기준점 제외)", () => {
  it("방금 수집되어 기준점 기록만 있는 물건을 담아도 피드에는 아무것도 나오지 않는다", () => {
    // 신규 수집 = 기준점(baseline) 행만 생긴다(감시 필드 4개).
    const itemId = seedItem();
    bookmarks.addBookmark(itemId);

    const { entries, total } = bookmarks.listFeed();

    expect(entries).toEqual([]);
    expect(total).toBe(0);
  });

  it("최저가 하락·유찰횟수 증가가 기록된 관심 물건은 최신순으로 피드에 나타난다", () => {
    const itemId = seedItem({ minBidPrice: 400_000_000, failedBidCount: 1 });
    bookmarks.addBookmark(itemId, { now: "2026-01-01T12:00:00.000Z" });

    // 실제 변경 발생: 최저가 하락 + 유찰횟수 증가.
    items.upsertItems(
      [makeItem({ minBidPrice: 300_000_000, failedBidCount: 2 })],
      { now: "2026-01-02T00:00:00.000Z" },
    );

    const { entries, total } = bookmarks.listFeed();
    expect(total).toBe(2);
    // 최신순 — 같은 changed_at이면 id 역순. 두 필드 모두 존재하는지만 확인(순서는 id DESC로 결정적).
    expect(entries.map((e) => e.field).sort()).toEqual(["failedBidCount", "minBidPrice"]);
    expect(entries.every((e) => e.changedAt === "2026-01-02T00:00:00.000Z")).toBe(true);
    expect(entries.every((e) => e.itemId === itemId)).toBe(true);
    expect(entries.every((e) => e.itemAddress === "서울특별시 관악구 신림동 1-1")).toBe(true);
    const priceEntry = entries.find((e) => e.field === "minBidPrice")!;
    expect(priceEntry.oldValue).toBe("400000000");
    expect(priceEntry.newValue).toBe("300000000");
  });

  it("관심 해제한 물건의 변동은 피드에서 사라진다", () => {
    const itemId = seedItem();
    bookmarks.addBookmark(itemId);
    items.upsertItems([makeItem({ minBidPrice: 300_000_000 })], {
      now: "2026-01-02T00:00:00.000Z",
    });
    expect(bookmarks.listFeed().total).toBe(1);

    bookmarks.removeBookmark(itemId);

    expect(bookmarks.listFeed()).toEqual({ entries: [], total: 0, page: 1, pageSize: 20 });
  });

  it("관심 물건이 아닌 물건의 변동은 애초에 피드에 나오지 않는다", () => {
    const bookmarkedId = seedItem({ caseNo: "2025타경1" });
    const otherId = seedItem({ caseNo: "2025타경2" });
    bookmarks.addBookmark(bookmarkedId);

    items.upsertItems(
      [
        makeItem({ caseNo: "2025타경1", minBidPrice: 300_000_000 }),
        makeItem({ caseNo: "2025타경2", minBidPrice: 100_000_000 }),
      ],
      { now: "2026-01-02T00:00:00.000Z" },
    );

    const { entries } = bookmarks.listFeed();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.itemId).toBe(bookmarkedId);
    expect(otherId).not.toBe(bookmarkedId);
  });

  it("sinceBookmarkedAt=true면 관심 등록 이후의 변동만 포함한다", () => {
    const itemId = seedItem({ minBidPrice: 400_000_000 }, "2026-01-01T00:00:00.000Z");
    // 등록 전 변동
    items.upsertItems([makeItem({ minBidPrice: 350_000_000 })], {
      now: "2026-01-02T00:00:00.000Z",
    });
    bookmarks.addBookmark(itemId, { now: "2026-01-03T00:00:00.000Z" });
    // 등록 후 변동
    items.upsertItems([makeItem({ minBidPrice: 300_000_000 })], {
      now: "2026-01-04T00:00:00.000Z",
    });

    // 기본(전체): 등록 전 변동도 포함된다(design.md D2 의도).
    expect(bookmarks.listFeed().total).toBe(2);

    // sinceBookmarkedAt=true: 등록 이후 변동만.
    const { entries, total } = bookmarks.listFeed({ sinceBookmarkedAt: true });
    expect(total).toBe(1);
    expect(entries[0]?.changedAt).toBe("2026-01-04T00:00:00.000Z");
  });

  it("변동이 없으면 빈 피드다(오류 아님)", () => {
    const itemId = seedItem();
    bookmarks.addBookmark(itemId);
    expect(bookmarks.listFeed()).toEqual({ entries: [], total: 0, page: 1, pageSize: 20 });
  });
});

describe("getUnreadCount / markFeedRead", () => {
  it("한 번도 읽지 않았으면 전체 변동이 미확인이다", () => {
    const itemId = seedItem();
    bookmarks.addBookmark(itemId);
    items.upsertItems([makeItem({ minBidPrice: 300_000_000 })], {
      now: "2026-01-02T00:00:00.000Z",
    });

    expect(bookmarks.getUnreadCount()).toBe(1);
  });

  it("마지막 확인 이후 변동이 3건 생기면 미확인이 3건이다", () => {
    const itemId = seedItem({ minBidPrice: 400_000_000, failedBidCount: 0, status: "신건" });
    bookmarks.addBookmark(itemId);
    bookmarks.markFeedRead("2026-01-02T00:00:00.000Z");

    items.upsertItems(
      [
        makeItem({
          minBidPrice: 300_000_000,
          failedBidCount: 1,
          status: "유찰 1회",
          // auctionDate는 그대로 둔다 — 바뀌면 4번째 감시 필드까지 변경으로 잡혀 이 테스트의
          // "정확히 3건"이라는 전제가 깨진다.
          auctionDate: "2026-10-01",
        }),
      ],
      { now: "2026-01-03T00:00:00.000Z" },
    );

    expect(bookmarks.getUnreadCount()).toBe(3);
  });

  it("읽음 처리를 하면 그 시점까지의 변동이 확인된 것으로 처리되고 미확인이 0이 된다", () => {
    const itemId = seedItem();
    bookmarks.addBookmark(itemId);
    items.upsertItems([makeItem({ minBidPrice: 300_000_000 })], {
      now: "2026-01-02T00:00:00.000Z",
    });
    expect(bookmarks.getUnreadCount()).toBe(1);

    bookmarks.markFeedRead("2026-01-02T00:00:00.000Z");

    expect(bookmarks.getUnreadCount()).toBe(0);
  });

  it("피드를 열어보기만 하고(listFeed) 읽음 처리를 하지 않으면 미확인 개수가 그대로 유지된다", () => {
    const itemId = seedItem();
    bookmarks.addBookmark(itemId);
    items.upsertItems([makeItem({ minBidPrice: 300_000_000 })], {
      now: "2026-01-02T00:00:00.000Z",
    });

    bookmarks.listFeed();
    bookmarks.listFeed({ sinceBookmarkedAt: true });

    expect(bookmarks.getUnreadCount()).toBe(1);
  });

  it("읽음 처리 이후 새로 생긴 변동만 다시 미확인으로 잡힌다", () => {
    const itemId = seedItem({ minBidPrice: 400_000_000 });
    bookmarks.addBookmark(itemId);
    items.upsertItems([makeItem({ minBidPrice: 300_000_000 })], {
      now: "2026-01-02T00:00:00.000Z",
    });
    bookmarks.markFeedRead("2026-01-02T00:00:00.000Z");
    expect(bookmarks.getUnreadCount()).toBe(0);

    items.upsertItems([makeItem({ minBidPrice: 200_000_000 })], {
      now: "2026-01-03T00:00:00.000Z",
    });
    expect(bookmarks.getUnreadCount()).toBe(1);
  });
});
