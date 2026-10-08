/**
 * `GET /api/photos/{itemId}/{seq}` HTTP 경계 테스트(switch-web-to-data-port 6.3).
 *
 * 2단계 `photos` 시나리오와 같은 사진 픽스처로, 두 데이터 원천에서 상태·본문(SHA-256)·헤더·텍스트 오류가
 * 같은지 확인한다. 기대값은 원천과 무관하게 하나다.
 */
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DATA_SOURCES_UNDER_TEST, useDataSource } from "@/lib/data-port/__tests__/data-sources";
import { CONTRACTS_DIR } from "@/lib/data-port/__tests__/golden-shapes";
import { closeDb, getDb, getRepository } from "@/lib/db";

import { GET } from "../route";

const originalEnv = process.env.AUCTIONBOSS_DB;
let workDir: string;

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const fixture = (name: string): Buffer => readFileSync(path.join(CONTRACTS_DIR, "photos", name));

beforeEach(() => {
  workDir = mkdtempSync(path.join(tmpdir(), "auctionboss-route-photos-"));
  process.env.AUCTIONBOSS_DB = path.join(workDir, "test.db");
  closeDb();
  getRepository().upsertItems([
    {
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
    },
  ]);
  const photosDir = path.join(workDir, "photos", "1");
  mkdirSync(photosDir, { recursive: true });
  copyFileSync(path.join(CONTRACTS_DIR, "photos/sample.png"), path.join(photosDir, "1.png"));
  copyFileSync(path.join(CONTRACTS_DIR, "photos/sample.jpg"), path.join(photosDir, "2.jpg"));
  // 사진 디렉터리 밖 파일(경로 이탈 시도 대상).
  copyFileSync(path.join(CONTRACTS_DIR, "photos/sample.png"), path.join(workDir, "outside.png"));
  const insert = getDb().prepare(
    "INSERT INTO item_photos (item_id, seq, file_path, file_size, mime_type, collected_at) VALUES (?, ?, ?, ?, ?, '2026-10-07T00:00:00.000Z')",
  );
  insert.run(1, 1, "1/1.png", 70, "image/png");
  insert.run(1, 2, "1/2.jpg", 22, "image/jpeg");
  insert.run(1, 3, "1/3.png", 70, "image/png");
  insert.run(1, 4, "../outside.png", 70, "image/png");
});

afterEach(() => {
  closeDb();
  if (originalEnv === undefined) delete process.env.AUCTIONBOSS_DB;
  else process.env.AUCTIONBOSS_DB = originalEnv;
  rmSync(workDir, { recursive: true, force: true });
});

function get(itemId: string, seq: string): Promise<Response> {
  return GET(new Request(`http://localhost/api/photos/${itemId}/${seq}`) as never, {
    params: Promise.resolve({ itemId, seq }),
  });
}

describe.each(DATA_SOURCES_UNDER_TEST)("GET /api/photos/{itemId}/{seq} (원천: %s)", (source) => {
  useDataSource(source);

  it.each([
    ["1", "1", "sample.png", "image/png"],
    ["1", "2", "sample.jpg", "image/jpeg"],
  ])("물건 %s의 사진 %s: 200, 본문 SHA-256·Content-Type·Cache-Control", async (itemId, seq, file, mime) => {
    const response = await get(itemId, seq);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(mime);
    expect(response.headers.get("cache-control")).toBe("public, max-age=86400, immutable");
    const body = new Uint8Array(await response.arrayBuffer());
    expect(body.byteLength).toBe(fixture(file).byteLength);
    expect(sha256(body)).toBe(sha256(fixture(file)));
  });

  it.each([
    ["1", "9", 404, "Not Found"],
    ["2", "1", 404, "Not Found"],
    ["12abc", "1", 404, "Not Found"],
    ["1", "3", 404, "File Not Found"],
    ["1", "4", 404, "File Not Found"],
    ["abc", "1", 400, "Invalid ID"],
    ["1", "abc", 400, "Invalid ID"],
  ])("물건 %s의 사진 %s: %i %s", async (itemId, seq, status, text) => {
    const response = await get(itemId, seq);
    expect(response.status).toBe(status);
    expect(await response.text()).toBe(text);
  });
});
