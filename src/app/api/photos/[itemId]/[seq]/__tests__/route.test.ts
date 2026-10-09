/**
 * `GET /api/photos/{itemId}/{seq}` HTTP 경계 테스트(switch-web-to-data-port 6.3).
 *
 * 웹 라우트는 백엔드 사진 API의 상태·본문 바이트·Content-Type·Cache-Control을 그대로 전달해야 한다.
 * 백엔드는 대역 `fetch`(Spring 원천)이고, 사진 픽스처는 동결된 계약 골든의 것을 쓴다
 * (migrate-data-and-cutover 8.2). 경로 이탈 같은 파일 쪽 방어는 백엔드(Java 사진 골든)가 증명한다.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { CONTRACTS_DIR } from "@/lib/data-port/__tests__/golden-shapes";
import { PHOTO_CACHE_CONTROL, useFakeBackend } from "@/lib/data-port/__tests__/fake-backend";

import { GET } from "../route";

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const fixture = (name: string): Buffer => readFileSync(path.join(CONTRACTS_DIR, "photos", name));

function get(itemId: string, seq: string): Promise<Response> {
  return GET(new Request(`http://localhost/api/photos/${itemId}/${seq}`) as never, {
    params: Promise.resolve({ itemId, seq }),
  });
}

describe("GET /api/photos/{itemId}/{seq} (원천: Spring)", () => {
  const backend = useFakeBackend();

  beforeEach(() => {
    backend.addPhoto(1, 1, { bytes: fixture("sample.png"), contentType: "image/png" });
    backend.addPhoto(1, 2, { bytes: fixture("sample.jpg"), contentType: "image/jpeg" });
    backend.addPhoto(1, 3); // 기록은 있으나 파일이 없다
  });

  it.each([
    ["1", "1", "sample.png", "image/png"],
    ["1", "2", "sample.jpg", "image/jpeg"],
  ])("물건 %s의 사진 %s: 200, 본문 SHA-256·Content-Type·Cache-Control", async (itemId, seq, file, mime) => {
    const response = await get(itemId, seq);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(mime);
    expect(response.headers.get("cache-control")).toBe(PHOTO_CACHE_CONTROL);
    const body = new Uint8Array(await response.arrayBuffer());
    expect(body.byteLength).toBe(fixture(file).byteLength);
    expect(sha256(body)).toBe(sha256(fixture(file)));
  });

  it.each([
    ["1", "9", 404, "Not Found"],
    ["2", "1", 404, "Not Found"],
    ["12abc", "1", 404, "Not Found"],
    ["1", "3", 404, "File Not Found"],
    ["abc", "1", 400, "Invalid ID"],
    ["1", "abc", 400, "Invalid ID"],
  ])("물건 %s의 사진 %s: %i %s", async (itemId, seq, status, text) => {
    const response = await get(itemId, seq);
    expect(response.status).toBe(status);
    expect(await response.text()).toBe(text);
  });

  it("잘못된 id는 백엔드를 부르지 않고, 정상 요청은 백엔드를 한 번만 부른다", async () => {
    await get("abc", "1");
    expect(backend.requests).toEqual([]);
    await get("1", "1");
    expect(backend.requests).toHaveLength(1);
  });
});
