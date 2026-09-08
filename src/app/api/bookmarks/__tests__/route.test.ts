/**
 * `GET /api/bookmarks` / `POST /api/bookmarks` HTTP 경계 테스트
 * (add-bookmarks-and-feed task 3.4). `src/app/api/items/[id]/changes/__tests__/route.test.ts`의
 * 패턴을 그대로 따른다 — 서버를 띄우지 않고 핸들러를 직접 호출한다.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { closeDb, getRepository } from "@/lib/db";
import type { AuctionItemInput } from "@/lib/domain";

import { GET, POST } from "../route";

const originalEnv = process.env.AUCTIONBOSS_DB;
let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(path.join(tmpdir(), "auctionboss-route-bookmarks-"));
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

function getRequest(search = ""): Request {
  return new Request(`http://localhost/api/bookmarks${search}`);
}

function postRequest(body: unknown): Request {
  return new Request("http://localhost/api/bookmarks", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function malformedPostRequest(rawBody: string): Request {
  return new Request("http://localhost/api/bookmarks", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: rawBody,
  });
}

describe("POST /api/bookmarks", () => {
  it("존재하는 물건을 담으면 201과 bookmarked:true인 물건을 돌려준다", async () => {
    const repo = getRepository();
    repo.upsertItems([makeItem()]);
    const itemId = repo.listItems().items[0]!.id;

    const response = await POST(postRequest({ itemId }));
    expect(response.status).toBe(201);

    const body = (await response.json()) as { item: { id: number; bookmarked: boolean } };
    expect(body.item.id).toBe(itemId);
    expect(body.item.bookmarked).toBe(true);
  });

  it("이미 담긴 물건을 다시 담아도 오류 없이 성공(200대)으로 처리된다", async () => {
    const repo = getRepository();
    repo.upsertItems([makeItem()]);
    const itemId = repo.listItems().items[0]!.id;

    await POST(postRequest({ itemId }));
    const response = await POST(postRequest({ itemId }));
    expect(response.status).toBe(201);
  });

  it("존재하지 않는 물건은 404이고 아무것도 저장하지 않는다", async () => {
    const response = await POST(postRequest({ itemId: 999999 }));
    expect(response.status).toBe(404);

    const list = await GET(getRequest());
    const body = (await list.json()) as { total: number };
    expect(body.total).toBe(0);
  });

  it("itemId가 없으면 400이다", async () => {
    const response = await POST(postRequest({}));
    expect(response.status).toBe(400);
  });

  it("JSON이 아닌 본문은 400이다", async () => {
    const response = await POST(malformedPostRequest("이건 JSON이 아니다"));
    expect(response.status).toBe(400);
  });
});

describe("GET /api/bookmarks", () => {
  it("관심 물건이 없으면 빈 배열과 total:0을 돌려준다(오류 아님)", async () => {
    const response = await GET(getRequest());
    expect(response.status).toBe(200);

    const body = (await response.json()) as { items: unknown[]; total: number };
    expect(body.items).toEqual([]);
    expect(body.total).toBe(0);
  });

  it("담긴 물건들을 물건 정보와 함께 돌려준다", async () => {
    const repo = getRepository();
    repo.upsertItems([makeItem({ caseNo: "2025타경1" }), makeItem({ caseNo: "2025타경2" })]);
    const [item1, item2] = repo.listItems({ pageSize: 10 }).items;
    await POST(postRequest({ itemId: item1!.id }));
    await POST(postRequest({ itemId: item2!.id }));

    const response = await GET(getRequest());
    const body = (await response.json()) as {
      items: Array<{ id: number; bookmarked: boolean }>;
      total: number;
    };
    expect(body.total).toBe(2);
    expect(body.items).toHaveLength(2);
    expect(body.items.every((item) => item.bookmarked)).toBe(true);
  });

  it("잘못된 page 파라미터는 400이다", async () => {
    const response = await GET(getRequest("?page=0"));
    expect(response.status).toBe(400);
  });
});
