/**
 * `POST /api/bookmarks/toggle` HTTP 경계 테스트(add-bookmarks-and-feed task 4.1/4.2).
 *
 * 목록/상세의 관심 토글 폼이 실제로 거치는 경로다 — form-urlencoded 본문을 받아 등록/해제
 * 하고, 검증된 `returnTo`로 303 리다이렉트한다는 것이 핵심 계약이다(design.md D5: 필터·
 * 정렬·페이지가 유지된 URL로 복귀).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { closeDb, getRepository, isBookmarked, listBookmarkedItems } from "@/lib/db";
import { DATA_SOURCES_UNDER_TEST, useDataSource } from "@/lib/data-port/__tests__/data-sources";
import type { AuctionItemInput } from "@/lib/domain";

import { POST } from "../route";

const originalEnv = process.env.AUCTIONBOSS_DB;
let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(path.join(tmpdir(), "auctionboss-route-bookmark-toggle-"));
  process.env.AUCTIONBOSS_DB = path.join(workDir, "test.db");
});

afterEach(() => {
  closeDb();
  if (originalEnv === undefined) delete process.env.AUCTIONBOSS_DB;
  else process.env.AUCTIONBOSS_DB = originalEnv;
  rmSync(workDir, { recursive: true, force: true });
});

function makeItem(overrides: Partial<AuctionItemInput> = {}): AuctionItemInput {
  return {
    court: "서울중앙지방법원",
    caseNo: "2025타경1",
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

function formRequest(fields: Record<string, string>): Request {
  const form = new URLSearchParams(fields);
  return new Request("http://localhost/api/bookmarks/toggle", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
}

describe.each(DATA_SOURCES_UNDER_TEST)("POST /api/bookmarks/toggle (원천: %s)", (source) => {
  useDataSource(source);

  it("bookmarked=false(현재 상태)로 제출하면 등록하고 returnTo로 303 리다이렉트한다", async () => {
    const repo = getRepository();
    repo.upsertItems([makeItem()]);
    const itemId = repo.listItems().items[0]!.id;

    const response = await POST(
      formRequest({ itemId: String(itemId), bookmarked: "false", returnTo: "/?sort=minBidPrice" }),
    );

    expect(response.status).toBe(303);
    expect(new URL(response.headers.get("location")!).pathname + new URL(response.headers.get("location")!).search).toBe(
      "/?sort=minBidPrice",
    );
    expect(isBookmarked(itemId)).toBe(true);
  });

  it("bookmarked=true(현재 상태)로 제출하면 해제한다", async () => {
    const repo = getRepository();
    repo.upsertItems([makeItem()]);
    const itemId = repo.listItems().items[0]!.id;
    const { addBookmark } = await import("@/lib/db");
    addBookmark(itemId);

    const response = await POST(
      formRequest({ itemId: String(itemId), bookmarked: "true", returnTo: `/items/${itemId}` }),
    );

    expect(response.status).toBe(303);
    expect(isBookmarked(itemId)).toBe(false);
  });

  it("returnTo가 외부 오리진이면(오픈 리다이렉트 시도) 기본 경로(/)로 안전하게 되돌린다", async () => {
    const repo = getRepository();
    repo.upsertItems([makeItem()]);
    const itemId = repo.listItems().items[0]!.id;

    const response = await POST(
      formRequest({
        itemId: String(itemId),
        bookmarked: "false",
        returnTo: "https://evil.example/steal",
      }),
    );

    expect(response.status).toBe(303);
    const location = new URL(response.headers.get("location")!);
    expect(location.origin).toBe("http://localhost");
    expect(location.pathname).toBe("/");
  });

  // 회귀 방지: 예전 검사는 "/\\evil.example"을 통과시켰고, 라우트의 new URL(returnTo, request.url)이
  // 이를 http://evil.example/ 로 풀어 외부로 리다이렉트했다.
  it.each(["/\\evil.example", "/\t/evil.example"])(
    "백슬래시·제어 문자로 외부 오리진을 노린 returnTo(%j)도 기본 경로로 되돌린다",
    async (returnTo) => {
      const repo = getRepository();
      repo.upsertItems([makeItem()]);
      const itemId = repo.listItems().items[0]!.id;

      const response = await POST(formRequest({ itemId: String(itemId), bookmarked: "false", returnTo }));

      expect(response.status).toBe(303);
      const location = new URL(response.headers.get("location")!);
      expect(location.origin).toBe("http://localhost");
      expect(location.pathname).toBe("/");
    },
  );

  it("returnTo가 프로토콜 상대 경로(//evil.example)여도 기본 경로로 되돌린다", async () => {
    const repo = getRepository();
    repo.upsertItems([makeItem()]);
    const itemId = repo.listItems().items[0]!.id;

    const response = await POST(
      formRequest({ itemId: String(itemId), bookmarked: "false", returnTo: "//evil.example" }),
    );

    const location = new URL(response.headers.get("location")!);
    expect(location.hostname).toBe("localhost");
  });

  it("itemId가 올바르지 않으면 400이다", async () => {
    const response = await POST(
      formRequest({ itemId: "not-a-number", bookmarked: "false", returnTo: "/" }),
    );
    expect(response.status).toBe(400);
  });

  it("존재하지 않는 물건은 404이고 관심 목록은 바뀌지 않는다", async () => {
    const repo = getRepository();
    repo.upsertItems([makeItem()]);
    const existingId = repo.listItems().items[0]!.id;
    const before = listBookmarkedItems().total;
    const response = await POST(
      formRequest({ itemId: "999999", bookmarked: "false", returnTo: "/" }),
    );
    expect(response.status).toBe(404);
    expect(isBookmarked(existingId)).toBe(false);
    expect(listBookmarkedItems().total).toBe(before);
  });
});
