/**
 * `DELETE /api/bookmarks/[itemId]` HTTP 경계 테스트(add-bookmarks-and-feed task 3.4).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { addBookmark, closeDb, getRepository, listBookmarkedItems } from "@/lib/db";
import type { AuctionItemInput } from "@/lib/domain";

import { DELETE } from "../route";

const originalEnv = process.env.AUCTIONBOSS_DB;
let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(path.join(tmpdir(), "auctionboss-route-bookmark-item-"));
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

function request(itemId: string): Request {
  return new Request(`http://localhost/api/bookmarks/${itemId}`, { method: "DELETE" });
}

function context(itemId: string): { params: Promise<{ itemId: string }> } {
  return { params: Promise.resolve({ itemId }) };
}

describe("DELETE /api/bookmarks/[itemId]", () => {
  it("담긴 물건을 해제하면 200과 bookmarked:false를 돌려주고 목록에서 사라진다", async () => {
    const repo = getRepository();
    repo.upsertItems([makeItem()]);
    const itemId = repo.listItems().items[0]!.id;

    addBookmark(itemId);
    expect(listBookmarkedItems().total).toBe(1);

    const response = await DELETE(request(String(itemId)), context(String(itemId)));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { itemId: number; bookmarked: boolean };
    expect(body.bookmarked).toBe(false);
    expect(listBookmarkedItems().total).toBe(0);
  });

  it("담기지 않은(존재하는) 물건을 해제해도 오류가 아니다", async () => {
    const repo = getRepository();
    repo.upsertItems([makeItem()]);
    const itemId = repo.listItems().items[0]!.id;

    const response = await DELETE(request(String(itemId)), context(String(itemId)));
    expect(response.status).toBe(200);
  });

  it("존재하지 않는 물건 id는 404다", async () => {
    const response = await DELETE(request("999999"), context("999999"));
    expect(response.status).toBe(404);
  });

  it("숫자가 아닌 id도 404다(존재하지 않는 물건과 같게 취급)", async () => {
    const response = await DELETE(request("not-a-number"), context("not-a-number"));
    expect(response.status).toBe(404);
  });
});
