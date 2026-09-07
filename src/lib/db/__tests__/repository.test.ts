import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AuctionItemInput } from "@/lib/domain";
import { openDatabase, type Db } from "../client";
import { ItemNotFoundError } from "../errors";
import {
  createRepository,
  type AuctionRepository,
  type ListItemsOptions,
} from "../repository";

/**
 * 모든 테스트는 인메모리 DB를 쓴다 — env(`AUCTIONBOSS_DB`)나 실제 `data/` 디렉터리를
 * 건드리지 않기 위함.
 */
let db: Db;
let repo: AuctionRepository;

beforeEach(() => {
  db = openDatabase(":memory:");
  repo = createRepository(db);
});

afterEach(() => {
  db.close();
});

function makeItem(overrides: Partial<AuctionItemInput> = {}): AuctionItemInput {
  return {
    court: "서울중앙지방법원",
    caseNo: "2025타경12345",
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

describe("upsertItems", () => {
  it("신규 물건을 저장하고 first_seen_at/last_seen_at을 기록한다", () => {
    const result = repo.upsertItems([makeItem()], { now: "2026-01-01T00:00:00.000Z" });

    expect(result).toEqual({ inserted: 1, updated: 0, changed: 0 });

    const { items, total } = repo.listItems();
    expect(total).toBe(1);
    expect(items[0]).toMatchObject({
      court: "서울중앙지방법원",
      caseNo: "2025타경12345",
      itemNo: "1",
      appraisalPrice: 500_000_000,
      minBidPrice: 400_000_000,
      auctionDate: "2026-10-01",
      failedBidCount: 1,
      status: "진행",
      firstSeenAt: "2026-01-01T00:00:00.000Z",
      lastSeenAt: "2026-01-01T00:00:00.000Z",
    });
  });

  it("같은 자연 키를 다시 수집하면 중복 행 없이 갱신하고 first_seen_at은 보존한다", () => {
    repo.upsertItems([makeItem()], { now: "2026-01-01T00:00:00.000Z" });

    const result = repo.upsertItems(
      [makeItem({ minBidPrice: 320_000_000, failedBidCount: 2, status: "유찰" })],
      { now: "2026-01-02T00:00:00.000Z" },
    );

    expect(result).toEqual({ inserted: 0, updated: 1, changed: 1 });

    const { items, total } = repo.listItems();
    expect(total).toBe(1); // 중복 행이 생기지 않는다
    expect(items[0]).toMatchObject({
      minBidPrice: 320_000_000,
      failedBidCount: 2,
      status: "유찰",
      firstSeenAt: "2026-01-01T00:00:00.000Z", // 최초 수집 시각은 그대로
      lastSeenAt: "2026-01-02T00:00:00.000Z", // 최종 수집 시각만 갱신
    });
  });

  it("자연 키의 어느 한 요소라도 다르면 별개 물건이다", () => {
    const result = repo.upsertItems([
      makeItem(),
      makeItem({ itemNo: "2" }),
      makeItem({ caseNo: "2025타경99999" }),
      makeItem({ court: "수원지방법원" }),
    ]);

    expect(result).toEqual({ inserted: 4, updated: 0, changed: 0 });
    expect(repo.listItems().total).toBe(4);
  });

  it("한 배치 안에 같은 키가 두 번 들어와도 행은 하나이고 카운트가 정확하다", () => {
    const result = repo.upsertItems([makeItem(), makeItem({ status: "변경" })]);

    expect(result).toEqual({ inserted: 1, updated: 1, changed: 1 });
    const { items, total } = repo.listItems();
    expect(total).toBe(1);
    expect(items[0]?.status).toBe("변경"); // 나중 값이 남는다
  });

  it("빈 배열은 아무 것도 하지 않는다", () => {
    expect(repo.upsertItems([])).toEqual({ inserted: 0, updated: 0, changed: 0 });
  });

  it("배치 전체가 한 트랜잭션이라 중간에 실패하면 아무 것도 저장되지 않는다", () => {
    const broken = { ...makeItem({ itemNo: "2" }), court: null } as unknown as AuctionItemInput;

    expect(() => repo.upsertItems([makeItem(), broken])).toThrow();
    expect(repo.listItems().total).toBe(0);
  });
});

describe("변경 이력 (item_changes)", () => {
  it("최초 저장 시 감시 필드별 기준점 행(old_value=NULL)을 만든다", () => {
    repo.upsertItems(
      [makeItem({ minBidPrice: 400_000_000, failedBidCount: 1, auctionDate: "2026-10-01", status: "진행" })],
      { now: "2026-01-01T00:00:00.000Z" },
    );
    const itemId = repo.listItems().items[0]!.id;
    const changes = repo.listItemChanges(itemId);

    expect(changes).toHaveLength(4);
    expect(changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "minBidPrice", oldValue: null, newValue: "400000000" }),
        expect.objectContaining({ field: "failedBidCount", oldValue: null, newValue: "1" }),
        expect.objectContaining({ field: "auctionDate", oldValue: null, newValue: "2026-10-01" }),
        expect.objectContaining({ field: "status", oldValue: null, newValue: "진행" }),
      ]),
    );
    for (const change of changes) {
      expect(change.itemId).toBe(itemId);
      expect(change.changedAt).toBe("2026-01-01T00:00:00.000Z");
    }
  });

  it("값이 NULL인 감시 필드는 기준점 행을 만들지 않는다", () => {
    repo.upsertItems([
      makeItem({ minBidPrice: null, failedBidCount: null, auctionDate: null, status: null }),
    ]);
    const itemId = repo.listItems().items[0]!.id;
    expect(repo.listItemChanges(itemId)).toEqual([]);
  });

  it("최저가 하락과 유찰횟수 증가를 이전 값·새 값과 변경 시각으로 기록한다", () => {
    repo.upsertItems([makeItem()], { now: "2026-01-01T00:00:00.000Z" });
    const itemId = repo.listItems().items[0]!.id;

    repo.upsertItems([makeItem({ minBidPrice: 320_000_000, failedBidCount: 2 })], {
      now: "2026-01-02T00:00:00.000Z",
    });

    const realChanges = repo.listItemChanges(itemId).filter((change) => change.oldValue !== null);
    expect(realChanges).toHaveLength(2);
    expect(realChanges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: "minBidPrice",
          oldValue: "400000000",
          newValue: "320000000",
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

  it("null과 값 사이의 변화도 감지한다(비교 규칙: null↔값은 변경)", () => {
    repo.upsertItems([makeItem({ auctionDate: null })], { now: "2026-01-01T00:00:00.000Z" });
    const itemId = repo.listItems().items[0]!.id;
    // auctionDate가 NULL이라 기준점 행이 없다.
    expect(repo.listItemChanges(itemId).some((c) => c.field === "auctionDate")).toBe(false);

    repo.upsertItems([makeItem({ auctionDate: "2026-11-01" })], { now: "2026-01-02T00:00:00.000Z" });

    const auctionDateChanges = repo
      .listItemChanges(itemId)
      .filter((c) => c.field === "auctionDate");
    expect(auctionDateChanges).toEqual([
      expect.objectContaining({ oldValue: null, newValue: "2026-11-01" }),
    ]);
  });

  it("null과 null은 같음으로 본다(이력이 남지 않는다)", () => {
    repo.upsertItems([makeItem({ auctionDate: null })], { now: "2026-01-01T00:00:00.000Z" });
    const itemId = repo.listItems().items[0]!.id;
    const baselineCount = repo.listItemChanges(itemId).length;

    repo.upsertItems([makeItem({ auctionDate: null })], { now: "2026-01-02T00:00:00.000Z" });

    expect(repo.listItemChanges(itemId)).toHaveLength(baselineCount);
  });

  it("가격·유찰횟수는 숫자로, 매각기일·상태는 문자열로 비교한다(값이 같으면 이력 없음)", () => {
    repo.upsertItems(
      [
        makeItem({
          minBidPrice: 400_000_000,
          failedBidCount: 1,
          auctionDate: "2026-10-01",
          status: "진행",
        }),
      ],
      { now: "2026-01-01T00:00:00.000Z" },
    );
    const itemId = repo.listItems().items[0]!.id;
    const baselineCount = repo.listItemChanges(itemId).length;

    // 값 자체는 동일 — 도메인 타입이 이미 숫자/문자열이라 재수집해도 같은 값이면 변화가 아니다.
    const result = repo.upsertItems(
      [
        makeItem({
          minBidPrice: 400_000_000,
          failedBidCount: 1,
          auctionDate: "2026-10-01",
          status: "진행",
        }),
      ],
      { now: "2026-01-02T00:00:00.000Z" },
    );

    expect(result).toEqual({ inserted: 0, updated: 1, changed: 0 });
    expect(repo.listItemChanges(itemId)).toHaveLength(baselineCount);
  });

  it("스펙 시나리오: 신규 2건 + 감시 필드 변경 1건 + 무변경 3건 → {inserted:2, updated:4, changed:1}", () => {
    repo.upsertItems(
      [
        makeItem({ itemNo: "1" }),
        makeItem({ itemNo: "2" }),
        makeItem({ itemNo: "3" }),
        makeItem({ itemNo: "4" }),
      ],
      { now: "2026-01-01T00:00:00.000Z" },
    );

    const result = repo.upsertItems(
      [
        makeItem({ itemNo: "1", minBidPrice: 300_000_000 }), // 감시 필드 변경
        makeItem({ itemNo: "2" }), // 무변경
        makeItem({ itemNo: "3" }), // 무변경
        makeItem({ itemNo: "4" }), // 무변경
        makeItem({ itemNo: "5" }), // 신규
        makeItem({ itemNo: "6" }), // 신규
      ],
      { now: "2026-01-02T00:00:00.000Z" },
    );

    expect(result).toEqual({ inserted: 2, updated: 4, changed: 1 });
  });

  /**
   * 핵심 테스트(design.md 리스크: 이력 테이블이 무한히 커짐 방지). 값이 변하지 않은 물건을
   * 여러 회차 반복 수집해도 이력은 최초 기준점만 유지돼야 한다 — 10분 주기 수집이
   * 쓰레기를 쌓지 않는다는 이 변경의 핵심 보장이다.
   */
  it("반복 수집에서 값이 변하지 않으면 이력이 최초 기준점만으로 유지된다", () => {
    repo.upsertItems([makeItem()], { now: "2026-01-01T00:00:00.000Z" });
    const itemId = repo.listItems().items[0]!.id;
    const baseline = repo.listItemChanges(itemId);
    expect(baseline).toHaveLength(4); // 감시 필드 4개 전부 non-null

    for (let i = 0; i < 5; i += 1) {
      repo.upsertItems([makeItem()], { now: `2026-01-0${2 + i}T00:00:00.000Z` });
    }

    expect(repo.listItemChanges(itemId)).toEqual(baseline); // 5회 반복 후에도 정확히 그대로
  });

  it("감시 대상이 아닌 필드(소재지)만 바뀌면 물건은 갱신되지만 이력은 남지 않는다", () => {
    repo.upsertItems([makeItem({ address: "서울특별시 관악구 신림동 1-1" })], {
      now: "2026-01-01T00:00:00.000Z",
    });
    const itemId = repo.listItems().items[0]!.id;
    const baselineCount = repo.listItemChanges(itemId).length;

    const result = repo.upsertItems([makeItem({ address: "서울특별시 관악구 신림동 2-2" })], {
      now: "2026-01-02T00:00:00.000Z",
    });

    expect(result).toEqual({ inserted: 0, updated: 1, changed: 0 });
    expect(repo.listItemChanges(itemId)).toHaveLength(baselineCount);
    expect(repo.getItemById(itemId)?.address).toBe("서울특별시 관악구 신림동 2-2");
  });

  /**
   * 원자성(design.md D3): 이력 기록이 실패하면 물건 갱신도 함께 롤백돼야 한다.
   * `item_changes` 테이블을 지워 이력 삽입 시점에 실제 오류가 나도록 강제한다 —
   * 물건 갱신 SQL 자체는 여전히 유효하므로, 이 실패가 트랜잭션 전체를 롤백시키는지가
   * 정확히 이 테스트가 확인하려는 것이다.
   */
  it("이력 기록이 실패하면 물건 갱신도 함께 롤백된다(원자성)", () => {
    repo.upsertItems([makeItem()], { now: "2026-01-01T00:00:00.000Z" });
    const itemId = repo.listItems().items[0]!.id;
    const before = repo.getItemById(itemId);

    db.exec("DROP TABLE item_changes");

    expect(() =>
      repo.upsertItems([makeItem({ minBidPrice: 1 })], { now: "2026-01-02T00:00:00.000Z" }),
    ).toThrow();

    // item_changes가 없어 이력 쪽은 확인할 수 없지만, 물건 쪽 갱신이 롤백됐는지는
    // 여전히 확인할 수 있다 — 실패 전 값 그대로여야 한다.
    expect(repo.getItemById(itemId)).toEqual(before);
  });
});

describe("listItemChanges", () => {
  it("시간순으로 돌려주고, 이력이 없으면 빈 배열이다", () => {
    repo.upsertItems([
      makeItem({ minBidPrice: null, failedBidCount: null, auctionDate: null, status: null }),
    ]);
    const itemId = repo.listItems().items[0]!.id;
    expect(repo.listItemChanges(itemId)).toEqual([]);

    repo.upsertItems(
      [makeItem({ minBidPrice: 400, failedBidCount: null, auctionDate: null, status: null })],
      { now: "2026-01-01T00:00:00.000Z" },
    );
    repo.upsertItems([makeItem({ minBidPrice: 300 })], { now: "2026-01-05T00:00:00.000Z" });
    repo.upsertItems([makeItem({ minBidPrice: 200 })], { now: "2026-01-10T00:00:00.000Z" });

    const minBidPriceChanges = repo
      .listItemChanges(itemId)
      .filter((change) => change.field === "minBidPrice");
    expect(minBidPriceChanges.map((c) => c.changedAt)).toEqual([
      "2026-01-01T00:00:00.000Z",
      "2026-01-05T00:00:00.000Z",
      "2026-01-10T00:00:00.000Z",
    ]);
    expect(minBidPriceChanges.map((c) => c.newValue)).toEqual(["400", "300", "200"]);
  });

  it("다른 물건의 이력과 섞이지 않는다", () => {
    repo.upsertItems([makeItem({ itemNo: "1" }), makeItem({ itemNo: "2" })]);
    const [item1, item2] = repo.listItems({ pageSize: 10 }).items;

    repo.upsertItems([makeItem({ itemNo: "1", minBidPrice: 1 })], {
      now: "2026-01-02T00:00:00.000Z",
    });

    const changes1 = repo.listItemChanges(item1!.id);
    const changes2 = repo.listItemChanges(item2!.id);
    expect(changes1.every((c) => c.itemId === item1!.id)).toBe(true);
    expect(changes2.every((c) => c.itemId === item2!.id)).toBe(true);
    expect(changes1.some((c) => c.oldValue !== null)).toBe(true); // item1만 실제 변경이 있다
    expect(changes2.some((c) => c.oldValue !== null)).toBe(false);
  });

  it("존재하지 않는 물건 id도 오류 없이 빈 배열을 돌려준다", () => {
    expect(repo.listItemChanges(999_999)).toEqual([]);
  });
});

describe("listItems", () => {
  beforeEach(() => {
    repo.upsertItems([
      makeItem({ itemNo: "1", auctionDate: "2026-03-03" }),
      makeItem({ itemNo: "2", auctionDate: "2026-01-01" }),
      makeItem({ itemNo: "3", auctionDate: null }),
      makeItem({ itemNo: "4", auctionDate: "2026-02-02" }),
      makeItem({ itemNo: "5", auctionDate: "2026-04-04" }),
    ]);
  });

  it("매각기일 오름차순으로 정렬하고 기일이 없는 물건은 뒤로 보낸다", () => {
    const { items } = repo.listItems({ pageSize: 10 });
    expect(items.map((item) => item.itemNo)).toEqual(["2", "4", "1", "5", "3"]);
  });

  it("페이지네이션은 전체 건수와 해당 페이지 조각을 돌려준다", () => {
    const page1 = repo.listItems({ page: 1, pageSize: 2 });
    expect(page1).toMatchObject({ total: 5, page: 1, pageSize: 2 });
    expect(page1.items.map((item) => item.itemNo)).toEqual(["2", "4"]);

    const page2 = repo.listItems({ page: 2, pageSize: 2 });
    expect(page2.items.map((item) => item.itemNo)).toEqual(["1", "5"]);

    const page3 = repo.listItems({ page: 3, pageSize: 2 });
    expect(page3.items.map((item) => item.itemNo)).toEqual(["3"]);

    const page4 = repo.listItems({ page: 4, pageSize: 2 });
    expect(page4.items).toEqual([]);
    expect(page4.total).toBe(5); // 전체 건수는 페이지와 무관하다
  });

  it("analyzed=false는 분석 결과가 있는 물건을 제외한다", () => {
    const target = repo.listItems({ pageSize: 10 }).items[0]!;
    repo.insertAnalysis({
      itemId: target.id,
      body: "# 분석",
      model: "claude",
      promptVersion: "v1",
    });

    const unanalyzed = repo.listItems({ analyzed: false, pageSize: 10 });
    expect(unanalyzed.total).toBe(4);
    expect(unanalyzed.items.map((item) => item.id)).not.toContain(target.id);

    const analyzed = repo.listItems({ analyzed: true, pageSize: 10 });
    expect(analyzed.total).toBe(1);
    expect(analyzed.items[0]?.id).toBe(target.id);

    expect(repo.listItems({ pageSize: 10 }).total).toBe(5); // 생략하면 전체
  });

  it("분석이 여러 건 달린 물건도 미분석 목록에 나타나지 않고 중복되지도 않는다", () => {
    const target = repo.listItems({ pageSize: 10 }).items[0]!;
    repo.insertAnalysis({ itemId: target.id, body: "a", model: null, promptVersion: "v1" });
    repo.insertAnalysis({ itemId: target.id, body: "b", model: null, promptVersion: "v1" });

    expect(repo.listItems({ analyzed: false, pageSize: 10 }).total).toBe(4);
    expect(repo.listItems({ analyzed: true, pageSize: 10 }).total).toBe(1);
  });

  it("잘못된 페이지 값은 안전한 값으로 보정된다", () => {
    expect(repo.listItems({ page: 0, pageSize: -5 })).toMatchObject({ page: 1, pageSize: 1 });
    expect(repo.listItems({ pageSize: 10_000 }).pageSize).toBe(200);
  });

  it("저장된 물건이 없으면 빈 결과를 돌려준다(오류가 아니다)", () => {
    const empty = createRepository(openDatabase(":memory:"));
    expect(empty.listItems()).toEqual({ items: [], total: 0, page: 1, pageSize: 20 });
  });

  /**
   * 회귀 방어: 분석 워커가 `?analyzed=false&pageSize=N`으로 분석 대상을 받아 간다.
   * 필터·정렬 파라미터를 하나도 주지 않은 호출은 이 변경 이전과 같은 결과·정렬·응답 형태여야 한다.
   */
  it("[회귀] 새 파라미터 없이 호출하면 기존과 동일하게 동작한다 (analyzer 계약)", () => {
    const analyzed = repo.listItems({ pageSize: 10 }).items[0]!;
    repo.insertAnalysis({ itemId: analyzed.id, body: "x", model: null, promptVersion: "v1" });

    const forAnalyzer = repo.listItems({ analyzed: false, pageSize: 5 });

    // 응답 형태(키 구성)가 그대로다.
    expect(Object.keys(forAnalyzer).sort()).toEqual(["items", "page", "pageSize", "total"]);
    expect(forAnalyzer).toMatchObject({ total: 4, page: 1, pageSize: 5 });
    // 정렬도 그대로: 매각기일 오름차순, 기일 없는 물건은 뒤.
    expect(forAnalyzer.items.map((item) => item.itemNo)).toEqual(["4", "1", "5", "3"]);
    expect(forAnalyzer.items.map((item) => item.id)).not.toContain(analyzed.id);
  });

  it("[회귀] 새 필터 필드를 undefined로 넘긴 것과 아예 넘기지 않은 것이 같다", () => {
    const bare = repo.listItems({ pageSize: 10 });
    const explicitUndefined = repo.listItems({
      pageSize: 10,
      usageTypes: undefined,
      minPrice: undefined,
      maxPrice: undefined,
      minFailedBidCount: undefined,
      addressKeyword: undefined,
      sort: undefined,
      direction: undefined,
    });

    expect(explicitUndefined).toEqual(bare);
    // 기본 정렬은 sort를 명시한 것과 같은 결과여야 한다(정렬식 하나로 합쳐진 것 확인).
    expect(repo.listItems({ pageSize: 10, sort: "auctionDate", direction: "asc" })).toEqual(bare);
  });
});

/**
 * "최근 변경 시각" 스칼라 서브쿼리 컬럼 (design.md D6). WHERE/ORDER BY/total에는 관여하지
 * 않고 표시용 컬럼만 하나 늘어나야 한다 — 그래서 별도 describe로 두고, 기존 필터·정렬
 * 테스트(위 "listItems", 아래 "listItems 필터·정렬")는 이 항목을 몰라도 그대로 통과해야 한다.
 */
describe("listItems — lastChangedAt (design.md D6)", () => {
  it("실제 변경 이력이 있으면 가장 최근 변경 시각을, 없으면 null을 준다", () => {
    repo.upsertItems([makeItem({ itemNo: "1" }), makeItem({ itemNo: "2" })], {
      now: "2026-01-01T00:00:00.000Z",
    });
    repo.upsertItems([makeItem({ itemNo: "1", minBidPrice: 1 })], {
      now: "2026-01-05T00:00:00.000Z",
    });

    const { items } = repo.listItems({ pageSize: 10 });
    const item1 = items.find((item) => item.itemNo === "1")!;
    const item2 = items.find((item) => item.itemNo === "2")!;

    expect(item1.lastChangedAt).toBe("2026-01-05T00:00:00.000Z");
    expect(item2.lastChangedAt).toBeNull(); // 기준점뿐이라 실제 변경이 없다
  });

  it("여러 번 변경됐으면 가장 최근 시각을 준다", () => {
    repo.upsertItems([makeItem()], { now: "2026-01-01T00:00:00.000Z" });
    repo.upsertItems([makeItem({ minBidPrice: 1 })], { now: "2026-01-05T00:00:00.000Z" });
    repo.upsertItems([makeItem({ minBidPrice: 2 })], { now: "2026-01-10T00:00:00.000Z" });

    const item = repo.listItems({ pageSize: 10 }).items[0]!;
    expect(item.lastChangedAt).toBe("2026-01-10T00:00:00.000Z");
  });

  it("기준점 행(old_value IS NULL)은 최근 변경 시각 계산에서 제외된다", () => {
    repo.upsertItems([makeItem()], { now: "2026-01-01T00:00:00.000Z" });
    const item = repo.listItems({ pageSize: 10 }).items[0]!;
    expect(item.lastChangedAt).toBeNull(); // 방금 만든 기준점만 있고 실제 변경은 없다
  });

  it("이 컬럼이 있어도 필터·정렬·total은 그대로다(회귀 방어)", () => {
    repo.upsertItems([
      makeItem({ itemNo: "1", auctionDate: "2026-03-03" }),
      makeItem({ itemNo: "2", auctionDate: "2026-01-01" }),
    ]);
    repo.upsertItems([makeItem({ itemNo: "1", minBidPrice: 1 })], {
      now: "2026-02-01T00:00:00.000Z",
    });

    const result = repo.listItems({ sort: "auctionDate", direction: "asc", pageSize: 10 });
    expect(result.total).toBe(2);
    expect(result.items.map((item) => item.itemNo)).toEqual(["2", "1"]); // 정렬 순서는 그대로
  });
});

/**
 * 필터·정렬용 데이터셋.
 *
 * | itemNo | 용도                     | 최저가 | 감정가 | 매각기일   | 유찰 | 소재지                    |
 * |--------|--------------------------|--------|--------|------------|------|---------------------------|
 * | 1      | 아파트                   | 100    | 200    | 2026-03-03 | 0    | 서울특별시 강남구 역삼동 1 |
 * | 2      | 다세대                   | 300    | 300    | 2026-01-01 | 3    | 서울특별시 관악구 신림동 2 |
 * | 3      | 상가,오피스텔,근린시설   | 500    | 1000   | (없음)     | 5    | 서울특별시 강남구 논현동 3 |
 * | 4      | 아파트                   | (없음) | (없음) | 2026-02-02 | (없음)| 100% 확실 상가            |
 * | 5      | (없음)                   | 700    | 0      | 2026-04-04 | 2    | 대전광역시 서구 둔산동 5   |
 *
 * 감정가 대비 최저가 비율: 1→0.5, 3→0.5(동률 → id 안정 정렬 확인), 2→1.0,
 * 4→NULL(최저가 없음), 5→NULL(감정가 0 → NULLIF).
 * 3번 용도 문자열의 쉼표는 실측값이다(`sources/courtauction/NOTES.md` §8).
 */
describe("listItems 필터·정렬", () => {
  beforeEach(() => {
    repo.upsertItems([
      makeItem({
        itemNo: "1",
        usageType: "아파트",
        minBidPrice: 100,
        appraisalPrice: 200,
        auctionDate: "2026-03-03",
        failedBidCount: 0,
        address: "서울특별시 강남구 역삼동 1",
      }),
      makeItem({
        itemNo: "2",
        usageType: "다세대",
        minBidPrice: 300,
        appraisalPrice: 300,
        auctionDate: "2026-01-01",
        failedBidCount: 3,
        address: "서울특별시 관악구 신림동 2",
      }),
      makeItem({
        itemNo: "3",
        usageType: "상가,오피스텔,근린시설",
        minBidPrice: 500,
        appraisalPrice: 1000,
        auctionDate: null,
        failedBidCount: 5,
        address: "서울특별시 강남구 논현동 3",
      }),
      makeItem({
        itemNo: "4",
        usageType: "아파트",
        minBidPrice: null,
        appraisalPrice: null,
        auctionDate: "2026-02-02",
        failedBidCount: null,
        address: "100% 확실 상가",
      }),
      makeItem({
        itemNo: "5",
        usageType: null,
        minBidPrice: 700,
        appraisalPrice: 0,
        auctionDate: "2026-04-04",
        failedBidCount: 2,
        address: "대전광역시 서구 둔산동 5",
      }),
    ]);
  });

  /** 조건에 맞는 itemNo를 정렬 결과 순서대로. */
  function found(query: Parameters<AuctionRepository["listItems"]>[0]): string[] {
    return repo.listItems({ pageSize: 10, ...query }).items.map((item) => item.itemNo);
  }

  describe("용도 필터", () => {
    it("선택한 용도만 남기고 전체 건수도 필터 기준으로 센다", () => {
      const result = repo.listItems({ usageTypes: ["아파트"], pageSize: 10 });
      expect(result.items.map((item) => item.itemNo).sort()).toEqual(["1", "4"]);
      expect(result.total).toBe(2);
    });

    it("여러 용도를 주면 그중 하나라도 맞는 물건이 나온다", () => {
      expect(found({ usageTypes: ["아파트", "다세대"] }).sort()).toEqual(["1", "2", "4"]);
    });

    it("쉼표가 들어간 용도 값도 그대로 매칭된다", () => {
      expect(found({ usageTypes: ["상가,오피스텔,근린시설"] })).toEqual(["3"]);
      // 쉼표로 쪼갠 조각은 어디에도 없다.
      expect(found({ usageTypes: ["상가", "오피스텔", "근린시설"] })).toEqual([]);
    });

    it("빈 배열이면 필터를 걸지 않는다", () => {
      expect(repo.listItems({ usageTypes: [], pageSize: 10 }).total).toBe(5);
    });

    it("용도가 없는(NULL) 물건은 용도 필터에 걸리지 않는다", () => {
      expect(found({ usageTypes: ["아파트", "다세대", "상가,오피스텔,근린시설"] })).not.toContain(
        "5",
      );
    });
  });

  describe("가격 범위 필터", () => {
    it("한쪽만 지정하면 그 방향으로만 제한한다", () => {
      expect(found({ minPrice: 300 }).sort()).toEqual(["2", "3", "5"]);
      expect(found({ maxPrice: 300 }).sort()).toEqual(["1", "2"]);
    });

    it("양쪽을 지정하면 그 구간만 남기고 경계값을 포함한다", () => {
      expect(found({ minPrice: 300, maxPrice: 500 }).sort()).toEqual(["2", "3"]);
      expect(found({ minPrice: 300, maxPrice: 300 })).toEqual(["2"]);
    });

    it("최저가가 없는(NULL) 물건은 가격 필터에서 제외된다", () => {
      expect(found({ minPrice: 0 })).not.toContain("4");
      expect(found({ maxPrice: 1_000_000 })).not.toContain("4");
    });
  });

  describe("유찰횟수 필터", () => {
    it("최소값 이상만 남긴다(경계 포함)", () => {
      expect(found({ minFailedBidCount: 3 }).sort()).toEqual(["2", "3"]);
      expect(found({ minFailedBidCount: 0 }).sort()).toEqual(["1", "2", "3", "5"]);
    });

    it("유찰횟수가 없는(NULL) 물건은 제외된다", () => {
      expect(found({ minFailedBidCount: 0 })).not.toContain("4");
    });
  });

  describe("소재지 키워드 검색", () => {
    it("키워드를 포함하는 물건만 남긴다", () => {
      expect(found({ addressKeyword: "강남구" }).sort()).toEqual(["1", "3"]);
      expect(found({ addressKeyword: "대전" })).toEqual(["5"]);
      expect(found({ addressKeyword: "부산" })).toEqual([]);
    });

    it("`%`는 와일드카드가 아니라 글자로 취급한다", () => {
      // 이스케이프하지 않으면 `%` 하나로 5건 전부가 매칭된다.
      expect(found({ addressKeyword: "%" })).toEqual(["4"]);
      expect(found({ addressKeyword: "100%" })).toEqual(["4"]);
      expect(found({ addressKeyword: "%확실%" })).toEqual([]);
    });

    it("`_`도 와일드카드가 아니라 글자로 취급한다", () => {
      expect(found({ addressKeyword: "강남_구" })).toEqual([]);
      expect(found({ addressKeyword: "_" })).toEqual([]);
    });

    it("이스케이프 문자(백슬래시) 자체도 글자로 찾는다", () => {
      repo.upsertItems([makeItem({ itemNo: "6", address: "C:\\경매\\자료" })]);
      expect(found({ addressKeyword: "\\" })).toEqual(["6"]);
      expect(found({ addressKeyword: "C:\\경매" })).toEqual(["6"]);
    });

    it("공백만 있는 키워드는 필터로 보지 않는다", () => {
      expect(repo.listItems({ addressKeyword: "   ", pageSize: 10 }).total).toBe(5);
    });
  });

  describe("정렬", () => {
    it("매각기일 — 오름/내림차순 모두 NULL은 뒤로", () => {
      expect(found({ sort: "auctionDate", direction: "asc" })).toEqual(["2", "4", "1", "5", "3"]);
      expect(found({ sort: "auctionDate", direction: "desc" })).toEqual(["5", "1", "4", "2", "3"]);
    });

    it("최저매각가격 — 오름/내림차순 모두 NULL은 뒤로", () => {
      expect(found({ sort: "minBidPrice", direction: "asc" })).toEqual(["1", "2", "3", "5", "4"]);
      expect(found({ sort: "minBidPrice", direction: "desc" })).toEqual(["5", "3", "2", "1", "4"]);
    });

    it("유찰횟수 — 오름/내림차순 모두 NULL은 뒤로", () => {
      expect(found({ sort: "failedBidCount", direction: "asc" })).toEqual([
        "1",
        "5",
        "2",
        "3",
        "4",
      ]);
      expect(found({ sort: "failedBidCount", direction: "desc" })).toEqual([
        "3",
        "2",
        "5",
        "1",
        "4",
      ]);
    });

    it("감정가 대비 최저가 비율 — 0 나눗셈 없이 NULL로 밀리고 동률은 id로 안정 정렬", () => {
      // 4번(최저가 NULL)과 5번(감정가 0 → NULLIF로 NULL)이 방향과 무관하게 뒤.
      expect(found({ sort: "bidRatio", direction: "asc" })).toEqual(["1", "3", "2", "4", "5"]);
      expect(found({ sort: "bidRatio", direction: "desc" })).toEqual(["2", "1", "3", "4", "5"]);
    });

    it("방향을 생략하면 오름차순이다", () => {
      expect(found({ sort: "minBidPrice" })).toEqual(found({ sort: "minBidPrice", direction: "asc" }));
    });

    it("정렬 기준을 생략하면 기존 기본 정렬(매각기일 오름차순)이다", () => {
      expect(found({})).toEqual(found({ sort: "auctionDate", direction: "asc" }));
    });

    it("정렬은 화이트리스트에만 있는 값을 받는다", () => {
      // 타입 밖에서(JS 호출자) 들어온 값은 조용히 무시하지 않고 던진다 — SQL로 새지 않는다.
      const bogus = { sort: "min_bid_price; DROP TABLE items" } as unknown as ListItemsOptions;
      expect(() => repo.listItems(bogus)).toThrow(/지원하지 않는 sort/);
      expect(repo.listItems({ pageSize: 10 }).total).toBe(5); // 테이블은 그대로다

      const bogusDir = { direction: "asc; DROP TABLE items" } as unknown as ListItemsOptions;
      expect(() => repo.listItems(bogusDir)).toThrow(/지원하지 않는 direction/);

      // 프로토타입 키도 통과하지 않는다(단순 인덱싱이면 함수가 SQL에 끼어든다).
      const protoKey = { sort: "constructor" } as unknown as ListItemsOptions;
      expect(() => repo.listItems(protoKey)).toThrow(/지원하지 않는 sort/);
    });

    it("정렬한 상태에서도 페이지 경계에서 물건이 중복·누락되지 않는다", () => {
      const pages = [1, 2, 3].flatMap(
        (page) =>
          repo.listItems({ sort: "bidRatio", direction: "asc", page, pageSize: 2 }).items,
      );
      expect(pages.map((item) => item.itemNo)).toEqual(["1", "3", "2", "4", "5"]);
    });
  });

  describe("필터 조합", () => {
    it("용도+가격범위+유찰횟수+키워드를 동시에 적용하면 교집합만 남고 total도 그 기준이다", () => {
      const result = repo.listItems({
        usageTypes: ["아파트", "다세대"],
        minPrice: 50,
        maxPrice: 400,
        minFailedBidCount: 0,
        addressKeyword: "서울",
        pageSize: 10,
      });

      // 3번(용도 불일치), 4번(최저가·유찰횟수 NULL, 소재지에 '서울' 없음), 5번(용도 NULL) 탈락.
      expect(result.items.map((item) => item.itemNo)).toEqual(["2", "1"]); // 매각기일 오름차순
      expect(result.total).toBe(2);
    });

    it("조건을 하나 더 좁히면 결과와 total이 함께 줄어든다", () => {
      const result = repo.listItems({
        usageTypes: ["아파트", "다세대"],
        minPrice: 50,
        maxPrice: 400,
        minFailedBidCount: 1,
        addressKeyword: "서울",
        pageSize: 10,
      });
      expect(result.items.map((item) => item.itemNo)).toEqual(["2"]);
      expect(result.total).toBe(1);
    });

    it("total은 페이지 조각이 아니라 필터 적용 전체 건수다", () => {
      const query = {
        usageTypes: ["아파트", "다세대"],
        minPrice: 50,
        maxPrice: 400,
        addressKeyword: "서울",
      };
      const page1 = repo.listItems({ ...query, page: 1, pageSize: 1 });
      const page2 = repo.listItems({ ...query, page: 2, pageSize: 1 });

      expect(page1.items.map((item) => item.itemNo)).toEqual(["2"]);
      expect(page2.items.map((item) => item.itemNo)).toEqual(["1"]);
      expect(page1.total).toBe(2);
      expect(page2.total).toBe(2);
    });

    it("analyzed 필터와 다른 필터를 함께 걸 수 있다", () => {
      const apartment = repo.listItems({ usageTypes: ["아파트"], pageSize: 10 }).items[0]!;
      repo.insertAnalysis({ itemId: apartment.id, body: "x", model: null, promptVersion: "v1" });

      const result = repo.listItems({ usageTypes: ["아파트"], analyzed: false, pageSize: 10 });
      expect(result.total).toBe(1);
      expect(result.items[0]?.id).not.toBe(apartment.id);
    });

    it("조건에 맞는 물건이 없으면 오류가 아니라 빈 결과다", () => {
      expect(repo.listItems({ usageTypes: ["없는용도"], pageSize: 10 })).toEqual({
        items: [],
        total: 0,
        page: 1,
        pageSize: 10,
      });
    });
  });
});

describe("listUsageTypes", () => {
  it("중복 없이 정렬해서 돌려주고 NULL은 제외한다", () => {
    repo.upsertItems([
      makeItem({ itemNo: "1", usageType: "아파트" }),
      makeItem({ itemNo: "2", usageType: "다세대" }),
      makeItem({ itemNo: "3", usageType: "오피스텔" }),
      makeItem({ itemNo: "4", usageType: "아파트" }), // 중복
      makeItem({ itemNo: "5", usageType: null }), // 제외
    ]);

    expect(repo.listUsageTypes()).toEqual(["다세대", "아파트", "오피스텔"]);
  });

  it("저장된 물건이 없으면 빈 배열이다(오류가 아니다)", () => {
    expect(repo.listUsageTypes()).toEqual([]);
  });

  it("용도가 전부 NULL이어도 빈 배열이다", () => {
    repo.upsertItems([makeItem({ usageType: null })]);
    expect(repo.listUsageTypes()).toEqual([]);
  });
});

describe("getItemById", () => {
  it("저장된 물건을 돌려주고, 없으면 null을 돌려준다", () => {
    repo.upsertItems([makeItem()]);
    const id = repo.listItems().items[0]!.id;

    expect(repo.getItemById(id)?.caseNo).toBe("2025타경12345");
    expect(repo.getItemById(999_999)).toBeNull();
  });
});

describe("insertAnalysis / getLatestAnalysis", () => {
  let itemId: number;

  beforeEach(() => {
    repo.upsertItems([makeItem()]);
    itemId = repo.listItems().items[0]!.id;
  });

  it("분석 결과를 저장하고 생성된 행을 돌려준다", () => {
    const analysis = repo.insertAnalysis(
      { itemId, body: "# 요약\n감정가 대비 저렴", model: "claude-opus", promptVersion: "v1" },
      { now: "2026-02-01T00:00:00.000Z" },
    );

    expect(analysis).toMatchObject({
      itemId,
      body: "# 요약\n감정가 대비 저렴",
      model: "claude-opus",
      promptVersion: "v1",
      analyzedAt: "2026-02-01T00:00:00.000Z",
    });
    expect(analysis.id).toBeGreaterThan(0);
  });

  it("존재하지 않는 물건이면 ItemNotFoundError를 던진다", () => {
    expect(() =>
      repo.insertAnalysis({ itemId: 999_999, body: "x", model: null, promptVersion: "v1" }),
    ).toThrow(ItemNotFoundError);
  });

  it("가장 최근 분석을 돌려주고, 분석 전이면 null이다", () => {
    expect(repo.getLatestAnalysis(itemId)).toBeNull();

    repo.insertAnalysis(
      { itemId, body: "old", model: null, promptVersion: "v1" },
      { now: "2026-02-01T00:00:00.000Z" },
    );
    repo.insertAnalysis(
      { itemId, body: "new", model: null, promptVersion: "v2" },
      { now: "2026-03-01T00:00:00.000Z" },
    );

    expect(repo.getLatestAnalysis(itemId)).toMatchObject({
      body: "new",
      promptVersion: "v2",
      analyzedAt: "2026-03-01T00:00:00.000Z",
    });
  });

  it("물건이 지워지면 분석도 함께 지워진다(FK ON DELETE CASCADE)", () => {
    repo.insertAnalysis({ itemId, body: "x", model: null, promptVersion: "v1" });
    db.prepare("DELETE FROM items WHERE id = ?").run(itemId);

    expect(db.prepare("SELECT COUNT(*) AS n FROM analyses").get()).toEqual({ n: 0 });
  });
});
