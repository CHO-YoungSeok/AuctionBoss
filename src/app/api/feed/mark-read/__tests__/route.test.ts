/**
 * `POST /api/feed/mark-read` HTTP 경계 테스트(switch-web-to-data-port 6.2). 백엔드는 대역 `fetch`
 * (Spring 원천)다(migrate-data-and-cutover 8.2).
 */
import { describe, expect, it } from "vitest";

import { getDataPort } from "@/lib/data-port";
import { useFakeBackend } from "@/lib/data-port/__tests__/fake-backend";

import { POST } from "../route";

function formRequest(fields: Record<string, string>): Request {
  return new Request("http://localhost/api/feed/mark-read", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  });
}

describe("POST /api/feed/mark-read (원천: Spring)", () => {
  const backend = useFakeBackend();

  /** 담은 물건의 변동 1건 → 미확인 1. */
  function seedUnread(): void {
    const id = backend.addItem({
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
    }).id;
    backend.bookmark(id, "2026-01-02T00:00:00.000Z");
    backend.addFeedEntry(id, "minBidPrice", "400000000", "300000000", "2026-01-03T00:00:00.000Z");
  }

  it("303으로 returnTo에 돌아가고 처리 후 미확인이 0이다", async () => {
    seedUnread();
    expect(await getDataPort().getUnreadCount()).toBe(1);

    const response = await POST(formRequest({ returnTo: "/feed?page=2" }));

    expect(response.status).toBe(303);
    const location = new URL(response.headers.get("location")!);
    expect(location.pathname + location.search).toBe("/feed?page=2");
    expect(await getDataPort().getUnreadCount()).toBe(0);
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

  it("피드 조회(listFeed)만으로는 읽음 요청이 가지 않아 미확인이 바뀌지 않는다", async () => {
    seedUnread();
    await getDataPort().listFeed({ page: 1 });
    expect(backend.lastReadAt).toBeNull();
    expect(backend.requests.some((r) => r.method === "POST")).toBe(false);
    expect(await getDataPort().getUnreadCount()).toBe(1);
  });

  it("백엔드가 실패하면 500이고 returnTo로 돌려보내지 않는다", async () => {
    backend.override("POST /api/feed/read", () => Response.json({ error: "boom" }, { status: 500 }));
    const response = await POST(formRequest({ returnTo: "/feed" }));
    expect(response.status).toBe(500);
  });
});
