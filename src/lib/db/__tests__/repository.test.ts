import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AuctionItemInput } from "@/lib/domain";
import { openDatabase, type Db } from "../client";
import { ItemNotFoundError } from "../errors";
import { createRepository, type AuctionRepository } from "../repository";

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

    expect(result).toEqual({ inserted: 1, updated: 0 });

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

    expect(result).toEqual({ inserted: 0, updated: 1 });

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

    expect(result).toEqual({ inserted: 4, updated: 0 });
    expect(repo.listItems().total).toBe(4);
  });

  it("한 배치 안에 같은 키가 두 번 들어와도 행은 하나이고 카운트가 정확하다", () => {
    const result = repo.upsertItems([makeItem(), makeItem({ status: "변경" })]);

    expect(result).toEqual({ inserted: 1, updated: 1 });
    const { items, total } = repo.listItems();
    expect(total).toBe(1);
    expect(items[0]?.status).toBe("변경"); // 나중 값이 남는다
  });

  it("빈 배열은 아무 것도 하지 않는다", () => {
    expect(repo.upsertItems([])).toEqual({ inserted: 0, updated: 0 });
  });

  it("배치 전체가 한 트랜잭션이라 중간에 실패하면 아무 것도 저장되지 않는다", () => {
    const broken = { ...makeItem({ itemNo: "2" }), court: null } as unknown as AuctionItemInput;

    expect(() => repo.upsertItems([makeItem(), broken])).toThrow();
    expect(repo.listItems().total).toBe(0);
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
