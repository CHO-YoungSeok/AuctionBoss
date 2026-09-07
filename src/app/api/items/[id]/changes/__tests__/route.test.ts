/**
 * `GET /api/items/[id]/changes` HTTP 경계 테스트.
 *
 * 서버를 띄우지 않고 라우트 핸들러를 직접 import해서 호출한다(`route.test.ts`의 패턴을
 * 그대로 따른다 — `src/app/api/items/__tests__/route.test.ts` 참조). 세 가지 경우를
 * 확인한다: 이력이 있는 물건 / 이력이 없는 물건(빈 배열) / 존재하지 않는 물건(404).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { closeDb, getRepository } from "@/lib/db";
import type { AuctionItemInput } from "@/lib/domain";

import { GET } from "../route";

const originalEnv = process.env.AUCTIONBOSS_DB;
let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(path.join(tmpdir(), "auctionboss-route-item-changes-"));
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

function request(id: string): Request {
  return new Request(`http://localhost/api/items/${id}/changes`);
}

function context(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

describe("GET /api/items/[id]/changes", () => {
  it("변경 이력이 있는 물건은 시간순 배열을 200으로 돌려준다", async () => {
    const repo = getRepository();
    repo.upsertItems([makeItem()], { now: "2026-01-01T00:00:00.000Z" });
    const itemId = repo.listItems().items[0]!.id;
    repo.upsertItems([makeItem({ minBidPrice: 300_000_000, failedBidCount: 2 })], {
      now: "2026-01-02T00:00:00.000Z",
    });

    const response = await GET(request(String(itemId)), context(String(itemId)));
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      changes: Array<{
        field: string;
        oldValue: string | null;
        newValue: string | null;
        changedAt: string;
      }>;
    };
    // 기준점 4건 + 실제 변경 2건.
    expect(body.changes).toHaveLength(6);
    expect(body.changes.filter((c) => c.oldValue !== null)).toHaveLength(2);
    expect(body.changes.filter((c) => c.oldValue !== null)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: "minBidPrice",
          oldValue: "400000000",
          newValue: "300000000",
          changedAt: "2026-01-02T00:00:00.000Z",
        }),
        expect.objectContaining({
          field: "failedBidCount",
          oldValue: "1",
          newValue: "2",
          changedAt: "2026-01-02T00:00:00.000Z",
        }),
      ]),
    );
  });

  it("변경 이력이 없는(존재하는) 물건은 빈 배열을 200으로 돌려준다", async () => {
    const repo = getRepository();
    // 감시 필드가 전부 NULL이면 기준점 행조차 생기지 않는다 — 진짜 빈 이력.
    repo.upsertItems([
      makeItem({ minBidPrice: null, failedBidCount: null, auctionDate: null, status: null }),
    ]);
    const itemId = repo.listItems().items[0]!.id;

    const response = await GET(request(String(itemId)), context(String(itemId)));
    expect(response.status).toBe(200);

    const body = (await response.json()) as { changes: unknown[] };
    expect(body.changes).toEqual([]);
  });

  it("존재하지 않는 물건 id는 404를 돌려준다", async () => {
    const response = await GET(request("999999"), context("999999"));
    expect(response.status).toBe(404);

    const body = (await response.json()) as { error: string };
    expect(typeof body.error).toBe("string");
  });

  it("숫자가 아닌 id도 404를 돌려준다(존재하지 않는 물건과 같게 취급)", async () => {
    const response = await GET(request("not-a-number"), context("not-a-number"));
    expect(response.status).toBe(404);
  });
});
