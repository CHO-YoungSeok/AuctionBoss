/**
 * `POST /api/feed/mark-read` HTTP 경계 테스트(switch-web-to-data-port 6.2). 두 데이터 원천에서 같은 결과여야 한다.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DATA_SOURCES_UNDER_TEST, useDataSource } from "@/lib/data-port/__tests__/data-sources";
import { getDataPort } from "@/lib/data-port";
import { addBookmark, closeDb, getRepository, getUnreadCount } from "@/lib/db";
import type { AuctionItemInput } from "@/lib/domain";

import { GET as getFeed } from "../../route";
import { POST } from "../route";

const originalEnv = process.env.AUCTIONBOSS_DB;
let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(path.join(tmpdir(), "auctionboss-route-feed-mark-read-"));
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

/** 담은 물건의 가격이 바뀐 변동 1건 → 미확인 1. */
function seedUnread(): void {
  const repo = getRepository();
  repo.upsertItems([makeItem()], { now: "2026-01-01T00:00:00.000Z" });
  addBookmark(repo.listItems().items[0]!.id, { now: "2026-01-02T00:00:00.000Z" });
  repo.upsertItems([makeItem({ minBidPrice: 300_000_000 })], { now: "2026-01-03T00:00:00.000Z" });
}

function formRequest(fields: Record<string, string>): Request {
  return new Request("http://localhost/api/feed/mark-read", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  });
}

describe.each(DATA_SOURCES_UNDER_TEST)("POST /api/feed/mark-read (원천: %s)", (source) => {
  useDataSource(source);

  it("303으로 returnTo에 돌아가고 처리 후 미확인이 0이다", async () => {
    seedUnread();
    expect(getUnreadCount()).toBe(1);

    const response = await POST(formRequest({ returnTo: "/feed?page=2" }));

    expect(response.status).toBe(303);
    const location = new URL(response.headers.get("location")!);
    expect(location.pathname + location.search).toBe("/feed?page=2");
    expect(getUnreadCount()).toBe(0);
  });

  it.each(["https://evil.example/x", "//evil.example", "/\\evil.example", "/\t/evil.example", undefined])(
    "returnTo(%j)가 안전하지 않거나 없으면 /로 되돌린다",
    async (returnTo) => {
      const response = await POST(formRequest(returnTo === undefined ? {} : { returnTo }));
      expect(response.status).toBe(303);
      const location = new URL(response.headers.get("location")!);
      expect(location.origin).toBe("http://localhost");
      expect(location.pathname).toBe("/");
    },
  );

  it("피드 조회(GET /api/feed, listFeed)만으로는 미확인이 바뀌지 않는다", async () => {
    seedUnread();
    const response = getFeed(new Request("http://localhost/api/feed"));
    expect(response.status).toBe(200);
    await getDataPort().listFeed({ page: 1 });
    expect(getUnreadCount()).toBe(1);
  });
});
