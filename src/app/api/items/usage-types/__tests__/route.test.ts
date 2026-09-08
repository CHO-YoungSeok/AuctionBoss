/**
 * `GET /api/items/usage-types` HTTP 경계 테스트 (design.md D3, "용도 목록 조회" 요구사항).
 *
 * 저장소 레벨(`repository.test.ts`)에는 `listUsageTypes` 테스트가 있지만, 이 라우트
 * 자체(정적 세그먼트가 `[id]`보다 먼저 매칭되는지 포함)를 확인하는 테스트는 없었다.
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
  workDir = mkdtempSync(path.join(tmpdir(), "auctionboss-route-usage-types-"));
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
    address: null,
    usageType: "아파트",
    appraisalPrice: null,
    minBidPrice: null,
    auctionDate: null,
    failedBidCount: null,
    status: null,
    ...overrides,
  };
}

describe("GET /api/items/usage-types", () => {
  it("저장된 물건에 존재하는 용도를 중복 없이 반환한다", async () => {
    const repo = getRepository();
    repo.upsertItems([
      makeItem({ itemNo: "1", usageType: "아파트" }),
      makeItem({ itemNo: "2", usageType: "다세대" }),
      makeItem({ itemNo: "3", usageType: "아파트" }), // 중복
      makeItem({ itemNo: "4", usageType: "오피스텔" }),
    ]);

    const response = GET();
    expect(response.status).toBe(200);
    const body = (await response.json()) as { usageTypes: string[] };
    expect(body.usageTypes.sort()).toEqual(["다세대", "아파트", "오피스텔"].sort());
  });

  it("저장된 물건이 없으면 오류 없이 빈 목록을 반환한다", async () => {
    const response = GET();
    expect(response.status).toBe(200);
    const body = (await response.json()) as { usageTypes: string[] };
    expect(body.usageTypes).toEqual([]);
  });

  it("복합 문자열은 쉼표로 쪼갠 개별 토큰으로 반환한다(ux-overhaul-phase2 design.md D2)", async () => {
    const repo = getRepository();
    repo.upsertItems([makeItem({ itemNo: "1", usageType: "상가,오피스텔,근린시설" })]);

    const response = GET();
    const body = (await response.json()) as { usageTypes: string[] };
    expect(body.usageTypes.sort()).toEqual(["근린시설", "상가", "오피스텔"]);
  });
});
