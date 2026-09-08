/**
 * `workers/lib/api.ts`의 `auctionItemSchema` 필드 집합 회귀 테스트(hardening-round1 task 2).
 *
 * 배경: 이 파일의 zod 스키마가 `AuctionItemInput`의 확장 필드 32개를 몰라 조용히
 * strip하던 결함이 이전 사이클에서 발견·수정됐고, 컴파일 시점 가드(`Assert<... extends
 * ...>`)가 그 자리에 남아 있었다. 이번 사이클에서 그 가드를 직접 점검해 보니, TypeScript의
 * 구조적 타이핑은 "옵셔널 필드가 한쪽에만 더 있는 것"을 assignability 위반으로 보지
 * 않아서 — 실제로 `AuctionItem.bookmarked`(옵셔널)가 스키마에 없는 채로 그 가드를 계속
 * 통과하고 있었다(발견 당시 재현: `AuctionItem`에 임의의 옵셔널 필드를 추가해도
 * `npx tsc --noEmit`이 그대로 clean이었다). `workers/lib/api.ts`에 새로 추가한
 * `KeysEqual` 기반 Assert가 컴파일 시점의 1차 방어선이고, 이 테스트는 그 방어선이
 * 지키는 실제 동작(응답 필드가 파싱 후에도 사라지지 않는다)을 `npm test`만으로도
 * 확인할 수 있게 하는 2차 방어선이다.
 */
import { describe, expect, it } from "vitest";

import type { AuctionItem } from "@/lib/domain";

import { fetchUnanalyzedItems, type FetchFn } from "../lib/api";

/** `AuctionItem`의 필드를 전부(확장 필드 32개 + bookmarked 포함) 채운 값. */
function makeFullItem(): AuctionItem {
  return {
    id: 1,
    court: "서울중앙지방법원",
    caseNo: "2025타경12345",
    itemNo: "1",
    address: "서울특별시 관악구 봉천동 1-1",
    usageType: "아파트",
    appraisalPrice: 500_000_000,
    minBidPrice: 320_000_000,
    auctionDate: "2026-10-15",
    failedBidCount: 2,
    status: "유찰 2회",
    firstSeenAt: "2026-09-01T00:00:00.000Z",
    lastSeenAt: "2026-09-06T00:00:00.000Z",
    lastChangedAt: "2026-09-05T00:00:00.000Z",
    bookmarked: true,
    minArea: 84,
    maxArea: 85,
    buildingDescription: "철근콘크리트구조\n84.99㎡",
    minBidPriceRound1: 500_000_000,
    minBidPriceRound2: 400_000_000,
    minBidPriceRound3: 320_000_000,
    minBidPriceRound4: null,
    minBidPriceRateRound1: 100,
    minBidPriceRateRound2: 80,
    usageCodeLarge: "10100",
    usageCodeMedium: "10101",
    usageCodeSmall: "10101001",
    sido: "서울특별시",
    sigungu: "관악구",
    dong: "봉천동",
    lotNumber: "1-1",
    buildingName: "래미안",
    buildingUnit: "101동 201호",
    coordinateX: "126.9",
    coordinateY: "37.5",
    coordinateLevel: "6",
    auctionTime: "10:00",
    auctionPlace: "본관 401호 경매법정",
    auctionDecisionDate: "2026-10-22",
    auctionRound: 3,
    note: "일괄매각",
    duplicateCaseNo: "2025타경99999",
    mergedCaseNo: "2025타경88888",
    courtDepartment: "경매5계",
    courtPhone: "02-530-1114",
    statusCode: "0002100001",
    itemStatusCode: "0001",
  };
}

function fakeFetch(item: AuctionItem): FetchFn {
  return async (url: string) => {
    const parsed = new URL(url);
    if (parsed.pathname === "/api/items") {
      return new Response(
        JSON.stringify({ items: [item], total: 1, page: 1, pageSize: 20 }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response("not found", { status: 404 });
  };
}

describe("auctionItemSchema 필드 집합 (hardening-round1 task 2)", () => {
  it("AuctionItem의 모든 필드(확장 필드 32개 + bookmarked)가 파싱 후에도 그대로 남는다", async () => {
    const full = makeFullItem();
    const result = await fetchUnanalyzedItems({
      baseUrl: "http://localhost:9999",
      pageSize: 20,
      fetchFn: fakeFetch(full),
    });

    expect(result.items).toHaveLength(1);
    const parsedItem = result.items[0] as AuctionItem;

    // 입력에 있던 키가 파싱 후 하나도 사라지지 않았는지 — 값 타입이 아니라 "필드가
    // 존재하는가" 자체를 확인한다. strip되면 그 키가 사라지고 undefined로 읽힌다.
    for (const key of Object.keys(full) as (keyof AuctionItem)[]) {
      expect(parsedItem).toHaveProperty(key);
      expect(parsedItem[key]).toEqual(full[key]);
    }

    // bookmarked는 이번에 발견된 실제 누락 필드였다 — 명시적으로 한 번 더 못 박는다.
    expect(parsedItem.bookmarked).toBe(true);
  });
});
