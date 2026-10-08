/** `GET /api/items/filter-options` HTTP 경계 테스트(switch-web-to-data-port 3.1). */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { closeDb, getRepository } from "@/lib/db";
import type { AuctionItemInput } from "@/lib/domain";

import { GET as GET_ITEM } from "../../[id]/route";
import { GET } from "../route";

const originalEnv = process.env.AUCTIONBOSS_DB;
let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(path.join(tmpdir(), "auctionboss-route-filter-options-"));
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

describe("GET /api/items/filter-options", () => {
  it("물건이 없으면 네 배열이 모두 비어 있다", async () => {
    const response = GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      usageTypes: [],
      sidoValues: [],
      sigunguValues: [],
      courtValues: [],
    });
  });

  it("네 선택지를 한 번에 돌려주고 법원은 문자 그대로 구분한다", async () => {
    getRepository().upsertItems([
      makeItem({ itemNo: "1", court: "A법원", usageType: "상가,아파트", sido: "서울특별시", sigungu: "관악구" }),
      makeItem({ itemNo: "2", court: "a법원", usageType: "다세대", sido: "경기도", sigungu: "관악구" }),
      makeItem({ itemNo: "3", court: "A법원 ", usageType: null, sido: null, sigungu: null }),
    ]);
    const response = GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      usageTypes: ["다세대", "상가", "아파트"],
      sidoValues: ["경기도", "서울특별시"],
      sigunguValues: ["관악구"],
      courtValues: ["A법원", "A법원 ", "a법원"],
    });
  });

  it("정적 경로 filter-options가 [id] 라우트에 잡히지 않는다(`[id]`는 숫자가 아니면 404)", async () => {
    // 같은 URL을 [id] 핸들러가 받으면 404가 된다 — Next가 정적 세그먼트를 먼저 매칭하므로 이 라우트가 응답한다.
    const viaId = await GET_ITEM(new Request("http://localhost/api/items/filter-options"), {
      params: Promise.resolve({ id: "filter-options" }),
    });
    expect(viaId.status).toBe(404);
    expect(GET().status).toBe(200);
  });
});
