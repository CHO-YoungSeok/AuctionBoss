/**
 * Spring 구현체가 보내는 요청은 모두 동결된 계약 골든이 증명한 요청이어야 한다
 * (migrate-data-and-cutover 8.2; 원래 `port-contract.test.ts`의 "골든 포함 검사").
 *
 * Spring 구현체의 직렬화·zod는 대역 fetch 테스트가, "백엔드가 그 요청에 이 응답을 낸다"는 것은 골든
 * (`ContractTest`·`ScenarioContractTest`, 은퇴 뒤에도 동결)이 증명한다. 이 검사는 둘 사이의 빈틈을 막는다:
 * 화면·폼·사진 라우트가 골든에 없는 요청 틀을 백엔드로 보내면 실패한다(증명 없는 요청).
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";

import * as toggle from "@/app/api/bookmarks/toggle/route";
import * as markRead from "@/app/api/feed/mark-read/route";
import * as photo from "@/app/api/photos/[itemId]/[seq]/route";
import BookmarksPage from "@/app/bookmarks/page";
import FeedPage from "@/app/feed/page";
import ItemDetailPage from "@/app/items/[id]/page";
import ItemListPage from "@/app/page";
import StatusPage from "@/app/status/page";

import { setDataPortForTesting } from "../index";
import { FakeBackend, shapeKey } from "./fake-backend";
import { loadGoldenShapes } from "./golden-shapes";

afterEach(() => setDataPortForTesting(null));

async function render(element: Promise<unknown>): Promise<void> {
  const resolved = (await element) as React.ReactElement;
  renderToStaticMarkup(createElement(() => resolved));
}

describe("Spring 구현체가 보낸 요청 틀은 골든에 있다", () => {
  it("다섯 화면·폼 두 개·사진 라우트가 보내는 요청 틀이 모두 성공 골든에 있다", async () => {
    const backend = new FakeBackend();
    const item = backend.addItem({
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
      internalCaseNo: "2025013000001",
      courtCode: "B000210",
    }, { photoStatus: "collected", photoCount: 1 });
    backend.addPhoto(item.id, 1, { bytes: new Uint8Array([1]), contentType: "image/png" });
    backend.addAnalysis(item.id, { body: "분석" });
    backend.bookmark(item.id);
    backend.addFeedEntry(item.id, "minBidPrice", "1", "2", "2026-01-03T00:00:00.000Z");
    backend.addRun("collector");
    setDataPortForTesting(backend.port());

    const form = (url: string, fields: Record<string, string>) =>
      new Request(url, { method: "POST", body: new URLSearchParams(fields) });
    await render(ItemListPage({ searchParams: Promise.resolve({ usage: "아파트" }) }));
    await render(ItemDetailPage({ params: Promise.resolve({ id: String(item.id) }) }));
    await render(BookmarksPage({ searchParams: Promise.resolve({ page: "1" }) }));
    await render(FeedPage({ searchParams: Promise.resolve({ page: "1" }) }));
    await render(StatusPage());
    await toggle.POST(form("http://localhost/api/bookmarks/toggle", { itemId: String(item.id), bookmarked: "false", returnTo: "/" }));
    await toggle.POST(form("http://localhost/api/bookmarks/toggle", { itemId: String(item.id), bookmarked: "true", returnTo: "/" }));
    await markRead.POST(form("http://localhost/api/feed/mark-read", { returnTo: "/feed" }));
    await photo.GET(new Request(`http://localhost/api/photos/${item.id}/1`) as never, {
      params: Promise.resolve({ itemId: String(item.id), seq: "1" }),
    });

    const golden = loadGoldenShapes();
    const sent = new Set(backend.requests.map(shapeKey));
    expect(sent.size).toBeGreaterThan(10);
    const unproven = [...sent].filter((key) => !golden.has(key));
    expect(unproven, "골든에 없는 요청 틀").toEqual([]);
  });
});
