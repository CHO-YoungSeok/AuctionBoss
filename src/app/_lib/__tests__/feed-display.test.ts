import { describe, expect, it } from "vitest";

import type { FeedEntry } from "@/lib/domain";

import { formatFeedEntryDisplay, isFeedEntryUnread } from "../feed-display";

function makeEntry(overrides: Partial<FeedEntry> = {}): FeedEntry {
  return {
    id: 1,
    itemId: 10,
    itemAddress: "서울특별시 관악구 신림동 1-1",
    field: "minBidPrice",
    oldValue: "500000000",
    newValue: "400000000",
    changedAt: "2026-01-02T00:00:00.000Z",
    bookmarkedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("formatFeedEntryDisplay", () => {
  it("최저매각가격 하락을 증감액·증감률과 함께 표시한다", () => {
    const display = formatFeedEntryDisplay(makeEntry());
    expect(display.label).toBe("최저매각가격");
    expect(display.direction).toBe("drop");
    expect(display.text).toContain("→");
    expect(display.text).toContain("-100,000,000원");
  });

  it("유찰횟수 변경을 표시한다(direction은 null)", () => {
    const display = formatFeedEntryDisplay(
      makeEntry({ field: "failedBidCount", oldValue: "1", newValue: "2" }),
    );
    expect(display.label).toBe("유찰횟수");
    expect(display.text).toBe("1회 → 2회");
    expect(display.direction).toBeNull();
  });

  it("진행상태 변경을 표시한다", () => {
    const display = formatFeedEntryDisplay(
      makeEntry({ field: "status", oldValue: "진행", newValue: "낙찰" }),
    );
    expect(display.text).toBe("진행 → 낙찰");
  });

  it("소재지가 없는 물건은 EMPTY로 표시한다", () => {
    const display = formatFeedEntryDisplay(makeEntry({ itemAddress: null }));
    expect(display.itemAddress).toBe("-");
  });

  it("소재지가 있으면 그대로 표시한다", () => {
    const display = formatFeedEntryDisplay(makeEntry());
    expect(display.itemAddress).toBe("서울특별시 관악구 신림동 1-1");
  });

  it("물건 상세의 변경 이력과 같은 문구 규칙을 쓴다(같은 필드값이면 같은 텍스트)", () => {
    // formatChangeDisplay가 쓰는 formatFieldChange를 공유하므로, 같은
    // field/oldValue/newValue를 넣으면 물건 상세와 피드가 같은 텍스트를 낸다.
    const display = formatFeedEntryDisplay(
      makeEntry({ field: "auctionDate", oldValue: "2026-01-01", newValue: "2026-02-01" }),
    );
    expect(display.text).toBe("2026-01-01 → 2026-02-01");
  });
});

describe("isFeedEntryUnread", () => {
  it("미확인 개수가 0이면 어떤 항목도 미확인이 아니다", () => {
    expect(isFeedEntryUnread({ page: 1, pageSize: 20, indexOnPage: 0, unreadCount: 0 })).toBe(
      false,
    );
  });

  it("1페이지에서 unreadCount 이내의 항목은 미확인이다", () => {
    expect(isFeedEntryUnread({ page: 1, pageSize: 20, indexOnPage: 0, unreadCount: 3 })).toBe(
      true,
    );
    expect(isFeedEntryUnread({ page: 1, pageSize: 20, indexOnPage: 2, unreadCount: 3 })).toBe(
      true,
    );
  });

  it("1페이지에서 unreadCount 이후의 항목은 미확인이 아니다", () => {
    expect(isFeedEntryUnread({ page: 1, pageSize: 20, indexOnPage: 3, unreadCount: 3 })).toBe(
      false,
    );
  });

  it("페이지네이션을 가로질러 전역 순번으로 판정한다", () => {
    // pageSize=20일 때 2페이지 0번 인덱스는 전역 순번 20 — unreadCount가 20이면 딱 경계라
    // 미확인이 아니고, 21이면 미확인이다.
    expect(isFeedEntryUnread({ page: 2, pageSize: 20, indexOnPage: 0, unreadCount: 20 })).toBe(
      false,
    );
    expect(isFeedEntryUnread({ page: 2, pageSize: 20, indexOnPage: 0, unreadCount: 21 })).toBe(
      true,
    );
  });

  it("2페이지 안에서도 인덱스가 커질수록 미확인 여부가 바뀔 수 있다", () => {
    // 전역 순번 20~24가 미확인(unreadCount=25)이라면 2페이지(순번 20~39)의 처음 5개만
    // 미확인이다.
    expect(isFeedEntryUnread({ page: 2, pageSize: 20, indexOnPage: 4, unreadCount: 25 })).toBe(
      true,
    );
    expect(isFeedEntryUnread({ page: 2, pageSize: 20, indexOnPage: 5, unreadCount: 25 })).toBe(
      false,
    );
  });
});
