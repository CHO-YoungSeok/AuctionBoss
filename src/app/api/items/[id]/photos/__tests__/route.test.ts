/** `GET /api/items/[id]/photos` HTTP 경계 테스트(switch-web-to-data-port 3.1). */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { closeDb, getRepository } from "@/lib/db";

import { GET } from "../route";

const originalEnv = process.env.AUCTIONBOSS_DB;
const originalConfig = process.env.AUCTIONBOSS_CONFIG;
let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(path.join(tmpdir(), "auctionboss-route-"));
  process.env.AUCTIONBOSS_DB = path.join(workDir, "test.db");
});

afterEach(() => {
  closeDb();
  if (originalEnv === undefined) delete process.env.AUCTIONBOSS_DB;
  else process.env.AUCTIONBOSS_DB = originalEnv;
  if (originalConfig === undefined) delete process.env.AUCTIONBOSS_CONFIG;
  else process.env.AUCTIONBOSS_CONFIG = originalConfig;
  rmSync(workDir, { recursive: true, force: true });
});

function call(id: string) {
  return GET(new Request(`http://localhost/api/items/${id}/photos`), { params: Promise.resolve({ id }) });
}

function seedItem(): number {
  const repo = getRepository();
  repo.upsertItems([
    {
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
    },
  ]);
  return repo.listItems().items[0].id;
}

describe("GET /api/items/[id]/photos", () => {
  it("사진이 없으면 빈 배열이다", async () => {
    const id = seedItem();
    const response = await call(String(id));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ photos: [] });
  });

  it("순번 오름차순으로 돌려주고 파일 경로 필드가 없다", async () => {
    const id = seedItem();
    getRepository().saveItemPhotos(
      id,
      [
        { seq: 2, filePath: "secret/2.jpg", fileSize: 22, mimeType: "image/jpeg" },
        { seq: 1, filePath: "secret/1.png", fileSize: 70, mimeType: "image/png" },
      ],
      "collected",
      { now: "2026-10-07T00:00:00.000Z" },
    );
    const response = await call(String(id));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { photos: Record<string, unknown>[] };
    expect(body.photos.map((p) => p.seq)).toEqual([1, 2]);
    for (const photo of body.photos) {
      expect(Object.keys(photo).sort()).toEqual(
        ["collectedAt", "fileSize", "id", "itemId", "mimeType", "seq"].sort(),
      );
    }
    expect(JSON.stringify(body)).not.toContain("secret");
  });

  it("없는 물건·숫자가 아닌 id는 404다", async () => {
    seedItem();
    for (const id of ["999999", "abc"]) {
      const response = await call(id);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: `물건을 찾을 수 없습니다: id=${id}` });
    }
  });
});
