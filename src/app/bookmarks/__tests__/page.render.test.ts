/**
 * 관심 물건 화면(`/bookmarks`) 렌더 테스트(switch-web-to-data-port 2.7). 임시 DB에 저장소 함수로 데이터를
 * 넣고 서버 컴포넌트를 직접 호출해 `renderToStaticMarkup`으로 HTML을 본다(상태·물건 상세 화면 테스트와
 * 같은 방식).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { addBookmark, closeDb, getRepository } from "@/lib/db";
import type { AuctionItemInput } from "@/lib/domain";

import { DATA_SOURCES_UNDER_TEST, useDataSource } from "@/lib/data-port/__tests__/data-sources";
import BookmarksPage from "../page";

let workDir: string;
let originalDbEnv: string | undefined;

beforeEach(() => {
  workDir = mkdtempSync(path.join(tmpdir(), "auctionboss-bookmarks-render-"));
  originalDbEnv = process.env.AUCTIONBOSS_DB;
  process.env.AUCTIONBOSS_DB = path.join(workDir, "test.db");
  closeDb();
});

afterEach(() => {
  closeDb();
  if (originalDbEnv === undefined) delete process.env.AUCTIONBOSS_DB;
  else process.env.AUCTIONBOSS_DB = originalDbEnv;
  rmSync(workDir, { recursive: true, force: true });
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

/** 물건 `count`건을 저장하고 id 목록을 돌려준다. */
function seedItems(count: number): number[] {
  const repo = getRepository();
  repo.upsertItems(
    Array.from({ length: count }, (_, i) => makeItem(i + 1)),
    { now: "2026-01-01T00:00:00.000Z" },
  );
  return repo.listItems({ pageSize: 200 }).items.map((item) => item.id);
}

async function renderBookmarks(page?: string): Promise<string> {
  const element = await BookmarksPage({
    searchParams: Promise.resolve(page === undefined ? {} : { page }),
  });
  return renderToStaticMarkup(createElement(() => element));
}

describe.each(DATA_SOURCES_UNDER_TEST)("관심 물건 화면 렌더링 [%s 원천]", (source) => {
  useDataSource(source);
  it("담은 물건이 없으면 표 대신 빈 상태 안내와 목록으로 가는 링크를 보여준다", async () => {
    seedItems(2); // 물건은 있어도 담은 것이 없다.

    const html = await renderBookmarks();

    expect(html).toContain("아직 담은 물건이 없습니다.");
    expect(html).toContain('<a href="/">물건 목록</a>에서 담아보세요.');
    expect(html).not.toContain("<table");
    expect(html).not.toContain("건</p>"); // 건수 문구도 없다(총 0건이면 null)
  });

  it("담은 물건만 행으로 나오고, 행마다 현재 경로를 returnTo로 가진 해제 폼이 있다", async () => {
    const [first, second] = seedItems(3);
    addBookmark(first, { now: "2026-01-02T00:00:00.000Z" });
    addBookmark(second, { now: "2026-01-02T00:00:01.000Z" });

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

  it("최근 담은 물건이 먼저 나온다", async () => {
    const [first, second] = seedItems(2);
    addBookmark(first, { now: "2026-01-02T00:00:00.000Z" });
    addBookmark(second, { now: "2026-01-03T00:00:00.000Z" });

    const html = await renderBookmarks();

    expect(html.indexOf(`href="/items/${second}"`)).toBeLessThan(html.indexOf(`href="/items/${first}"`));
  });

  it("2페이지에서는 해제 폼의 returnTo가 ?page=2를 유지하고 이전·다음 링크가 맞다", async () => {
    const ids = seedItems(21);
    ids.forEach((id, i) => addBookmark(id, { now: `2026-01-02T00:00:${String(i).padStart(2, "0")}.000Z` }));

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
    const [id] = seedItems(1);
    addBookmark(id);
    const html = await renderBookmarks("abc");
    expect(html).toContain("1 / 1");
    expect(await renderBookmarks("0")).toContain("1 / 1");
  });

  it("미확인 변동이 있으면 피드 링크에 개수가 붙고, 없으면 붙지 않는다", async () => {
    const [id] = seedItems(1);
    addBookmark(id, { now: "2026-01-02T00:00:00.000Z" });
    expect(await renderBookmarks()).toContain('<a href="/feed">변동 피드</a>');

    // 담은 물건의 가격이 바뀌면(변동 1건 이상) 읽지 않은 변동이 생긴다.
    getRepository().upsertItems([makeItem(1, { minBidPrice: 300_000_000 })], {
      now: "2026-01-03T00:00:00.000Z",
    });
    expect(await renderBookmarks()).toMatch(/변동 피드 \(미확인 \d+건\)/);
  });
});
