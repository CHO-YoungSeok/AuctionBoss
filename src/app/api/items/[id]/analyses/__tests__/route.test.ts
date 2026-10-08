/** `GET /api/items/[id]/analyses` HTTP 경계 테스트(switch-web-to-data-port 3.1). */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { closeDb, getRepository } from "@/lib/db";
import type { AuctionItemInput } from "@/lib/domain";

import { GET } from "../route";

const originalEnv = process.env.AUCTIONBOSS_DB;
let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(path.join(tmpdir(), "auctionboss-route-analyses-"));
  process.env.AUCTIONBOSS_DB = path.join(workDir, "test.db");
});

afterEach(() => {
  closeDb();
  if (originalEnv === undefined) delete process.env.AUCTIONBOSS_DB;
  else process.env.AUCTIONBOSS_DB = originalEnv;
  rmSync(workDir, { recursive: true, force: true });
});

const item: AuctionItemInput = {
  court: "서울중앙지방법원",
  caseNo: "2025타경1",
  itemNo: "1",
  address: null,
  usageType: null,
  appraisalPrice: null,
  minBidPrice: null,
  auctionDate: null,
  failedBidCount: null,
  status: null,
};

function seed(analysisCount: number): number {
  const repo = getRepository();
  repo.upsertItems([item]);
  const id = repo.listItems().items[0].id;
  for (let i = 1; i <= analysisCount; i += 1) {
    repo.insertAnalysis(
      { itemId: id, body: `본문 ${i}`, model: null, promptVersion: "v1" },
      { now: new Date(Date.UTC(2026, 9, i)).toISOString() },
    );
  }
  return id;
}

function call(id: string, query = "") {
  return GET(new Request(`http://localhost/api/items/${id}/analyses${query ? `?${query}` : ""}`), {
    params: Promise.resolve({ id }),
  });
}

interface Body {
  analyses: { id: number; body: string }[];
  total: number;
  details?: { field: string }[];
}

describe("GET /api/items/[id]/analyses", () => {
  it("분석이 없으면 빈 이력과 total 0이다", async () => {
    const id = seed(0);
    const response = await call(String(id));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ analyses: [], total: 0 });
  });

  it("기본 10건, limit이 잘라도 total은 전체 건수이고 최신순이다", async () => {
    const id = seed(12);
    const all = (await (await call(String(id))).json()) as Body;
    expect(all.analyses).toHaveLength(10);
    expect(all.total).toBe(12);

    const body = (await (await call(String(id), "limit=11")).json()) as Body;
    expect(body.analyses).toHaveLength(11);
    expect(body.total).toBe(12);
    const ids = body.analyses.map((a) => a.id);
    expect(ids).toEqual([...ids].sort((a, b) => b - a));

    const one = (await (await call(String(id), "limit=1")).json()) as Body;
    expect(one.analyses).toHaveLength(1);
    expect(one.analyses[0].id).toBe(ids[0]);
  });

  it.each(["limit=0", "limit=abc", "limit=51", "limit=", "limit=-1", "limit=1.5"])(
    "%s 는 400이고 details에 limit이 있다",
    async (query) => {
      const id = seed(1);
      const response = await call(String(id), query);
      expect(response.status).toBe(400);
      const body = (await response.json()) as Body;
      expect(body.details?.map((d) => d.field)).toContain("limit");
    },
  );

  it("없는 물건·숫자가 아닌 id는 404다", async () => {
    seed(1);
    for (const id of ["999999", "abc"]) {
      const response = await call(id);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: `물건을 찾을 수 없습니다: id=${id}` });
    }
  });
});
