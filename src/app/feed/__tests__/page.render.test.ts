/**
 * 변동 피드 화면(`/feed`) 렌더 테스트(switch-web-to-data-port 2.7). `/bookmarks` 렌더 테스트와 같은 방식
 * (백엔드 대역 `fetch`, migrate-data-and-cutover 8.2). 미확인 판정(읽음 시각 이후의 변동)은 백엔드의 일이고
 * 대역은 같은 규칙으로 개수를 낸다 — 화면은 받은 개수와 표시를 그대로 그리는지만 본다.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { AuctionItemInput } from "@/lib/domain";

import { useFakeBackend, type FakeBackend } from "@/lib/data-port/__tests__/fake-backend";
import FeedPage from "../page";

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

/** 물건 하나를 담고 가격이 두 번 바뀐 변동(2026-01-02, 2026-01-03)을 피드에 넣는다. */
function seedBookmarkedItemWithChanges(backend: FakeBackend): number {
  const id = backend.addItem(makeItem()).id;
  backend.bookmark(id, "2026-01-01T12:00:00.000Z");
  backend.addFeedEntry(id, "minBidPrice", "400000000", "320000000", "2026-01-02T00:00:00.000Z");
  backend.addFeedEntry(id, "minBidPrice", "320000000", "256000000", "2026-01-03T00:00:00.000Z");
  return id;
}

async function renderFeed(page?: string): Promise<string> {
  const element = await FeedPage({ searchParams: Promise.resolve(page === undefined ? {} : { page }) });
  return renderToStaticMarkup(createElement(() => element));
}

describe("변동 피드 화면 렌더링 [Spring 원천]", () => {
  const backend = useFakeBackend();

  it("변동이 없으면 빈 상태 안내만 있고 읽음 버튼도 없다", async () => {
    const html = await renderFeed();

    expect(html).toContain("<h1>변동 피드</h1>");
    expect(html).toContain("아직 변동이 없습니다.");
    expect(html).not.toContain("mark-read");
    expect(html).not.toContain("badge-unread");
  });

  it("한 번도 읽지 않았으면 모든 변동이 미확인이고, 읽음 버튼은 현재 경로를 returnTo로 갖는다", async () => {
    seedBookmarkedItemWithChanges(backend);
    const unread = 2;

    const html = await renderFeed();

    expect(html).toContain(`미확인 ${unread}건`);
    expect(html).toContain(`전체 읽음 처리 (미확인 ${unread}건)`);
    expect(html).toContain('action="/api/feed/mark-read"');
    expect(html).toContain('name="returnTo" value="/feed"');
    expect(html.split("badge-unread").length - 1).toBe(unread);
    expect(html).toContain("서울특별시 관악구 신림동 1-1");
    expect(html).toContain("320,000,000원");
  });

  it("읽음 처리 뒤에는 읽음 버튼과 미확인 표시가 사라지지만 변동 행은 그대로 보인다", async () => {
    seedBookmarkedItemWithChanges(backend);
    backend.lastReadAt = "2026-01-04T00:00:00.000Z";

    const html = await renderFeed();

    expect(html).not.toContain("mark-read");
    expect(html).not.toContain("badge-unread");
    expect(html).not.toContain("feed-row-unread");
    expect(html).toContain("feed-row");
    expect(html).toContain("미확인 0건");
  });

  it("일부만 읽었으면 최근 변동 몇 건만 미확인으로 강조된다", async () => {
    seedBookmarkedItemWithChanges(backend);
    backend.lastReadAt = "2026-01-02T12:00:00.000Z"; // 01-03 변동만 남는다

    const html = await renderFeed();

    expect(html.split("feed-row-unread").length - 1).toBe(1);
    expect(html).toContain("전체 읽음 처리 (미확인 1건)");
  });

  it("피드를 여는 것만으로는 읽음 처리가 일어나지 않는다(읽음 요청을 보내지 않는다)", async () => {
    seedBookmarkedItemWithChanges(backend);

    await renderFeed();
    await renderFeed();

    expect(backend.lastReadAt).toBeNull();
    expect(backend.requests.some((r) => r.method !== "GET")).toBe(false);
  });

  it("잘못된 page는 1페이지로 복구한다", async () => {
    seedBookmarkedItemWithChanges(backend);
    expect(await renderFeed("abc")).toContain("1 / 1");
    expect(await renderFeed("-3")).toContain("1 / 1");
  });
});
