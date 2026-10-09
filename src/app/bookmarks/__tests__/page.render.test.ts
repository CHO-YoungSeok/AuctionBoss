/**
 * 관심 물건 화면(`/bookmarks`) 렌더 테스트(switch-web-to-data-port 2.7). 백엔드 대역 `fetch`(Spring 원천)에
 * 데이터를 넣고 서버 컴포넌트를 직접 호출해 `renderToStaticMarkup`으로 HTML을 본다
 * (migrate-data-and-cutover 8.2).
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { AuctionItemInput } from "@/lib/domain";

import { useFakeBackend, type FakeBackend } from "@/lib/data-port/__tests__/fake-backend";
import BookmarksPage from "../page";

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

/** 물건 `count`건을 저장하고 id 목록을 돌려준다. */
function seedItems(backend: FakeBackend, count: number): number[] {
  return Array.from({ length: count }, (_, i) => backend.addItem(makeItem(i + 1)).id);
}

async function renderBookmarks(page?: string): Promise<string> {
  const element = await BookmarksPage({
    searchParams: Promise.resolve(page === undefined ? {} : { page }),
  });
  return renderToStaticMarkup(createElement(() => element));
}

describe("관심 물건 화면 렌더링 [Spring 원천]", () => {
  const backend = useFakeBackend();

  it("담은 물건이 없으면 표 대신 빈 상태 안내와 목록으로 가는 링크를 보여준다", async () => {
    seedItems(backend, 2); // 물건은 있어도 담은 것이 없다.

    const html = await renderBookmarks();

    expect(html).toContain("아직 담은 물건이 없습니다.");
    expect(html).toContain('<a href="/">물건 목록</a>에서 담아보세요.');
    expect(html).not.toContain("<table");
    expect(html).not.toContain("건</p>"); // 건수 문구도 없다(총 0건이면 null)
  });

  it("담은 물건만 행으로 나오고, 행마다 현재 경로를 returnTo로 가진 해제 폼이 있다", async () => {
    const [first, second] = seedItems(backend, 3);
    backend.bookmark(first, "2026-01-02T00:00:00.000Z");
    backend.bookmark(second, "2026-01-02T00:00:01.000Z");

    const html = await renderBookmarks();

    expect(html).toContain("<h1>관심 물건</h1>");
    expect(html).toContain("2건");
    expect(html).toContain(`href="/items/${first}"`);
    expect(html).toContain(`href="/items/${second}"`);
    expect(html.split("<tr>").length - 1).toBe(1 + 2); // 머리글 + 2행
    // 해제 폼: 관심 상태 true, 돌아갈 경로는 이 화면 자체.
    expect(html.split('action="/api/bookmarks/toggle"').length - 1).toBe(2);
    expect(html.split('name="bookmarked" value="true"').length - 1).toBe(2);
    expect(html.split('name="returnTo" value="/bookmarks"').length - 1).toBe(2);
    expect(html.split("★ 관심 해제").length - 1).toBe(2);
  });

  it("최근 담은 물건이 먼저 나온다(순서는 백엔드가 정하고 화면은 받은 순서를 지킨다)", async () => {
    const [first, second] = seedItems(backend, 2);
    backend.bookmark(first, "2026-01-02T00:00:00.000Z");
    backend.bookmark(second, "2026-01-03T00:00:00.000Z");

    const html = await renderBookmarks();

    expect(html.indexOf(`href="/items/${second}"`)).toBeLessThan(html.indexOf(`href="/items/${first}"`));
  });

  it("2페이지에서는 해제 폼의 returnTo가 ?page=2를 유지하고 이전·다음 링크가 맞다", async () => {
    const ids = seedItems(backend, 21);
    ids.forEach((id, i) => backend.bookmark(id, `2026-01-02T00:00:${String(i).padStart(2, "0")}.000Z`));

    const page1 = await renderBookmarks();
    expect(page1).toContain("21건");
    expect(page1).toContain("1 / 2");
    expect(page1).toContain('href="/bookmarks?page=2">다음 →');
    expect(page1).toContain('<span class="disabled">← 이전</span>');

    const page2 = await renderBookmarks("2");
    expect(page2).toContain("2 / 2");
    expect(page2.split('name="returnTo" value="/bookmarks?page=2"').length - 1).toBe(1);
    expect(page2).toContain('href="/bookmarks">← 이전');
    expect(page2).toContain('<span class="disabled">다음 →</span>');
  });

  it("잘못된 page는 1페이지로 복구한다", async () => {
    const [id] = seedItems(backend, 1);
    backend.bookmark(id);
    const html = await renderBookmarks("abc");
    expect(html).toContain("1 / 1");
    expect(await renderBookmarks("0")).toContain("1 / 1");
  });

  it("미확인 변동이 있으면 피드 링크에 개수가 붙고, 없으면 붙지 않는다", async () => {
    const [id] = seedItems(backend, 1);
    backend.bookmark(id, "2026-01-02T00:00:00.000Z");
    expect(await renderBookmarks()).toContain('<a href="/feed">변동 피드</a>');

    // 담은 물건의 가격이 바뀌면(변동 1건 이상) 읽지 않은 변동이 생긴다.
    backend.addFeedEntry(id, "minBidPrice", "400000000", "300000000", "2026-01-03T00:00:00.000Z");
    expect(await renderBookmarks()).toMatch(/변동 피드 \(미확인 \d+건\)/);
  });
});
