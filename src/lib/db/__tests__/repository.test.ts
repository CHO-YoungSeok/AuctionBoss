import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { hasActiveFilters, type AuctionItemInput } from "@/lib/domain";
import { openDatabase, type Db } from "../client";
import { createBookmarksRepository } from "../bookmarks";
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

    // changed는 0이다(finding 6 수정) — 이 물건은 배치가 시작하기 전에는 존재하지
    // 않았다(신규). 배치 안에서 두 번째 행이 첫 번째 행과 다른 값(status)을 가져와도
    // 그건 "배치 시작 전 저장값 대비 변경"이 아니라 신규 저장의 연장일 뿐이다 — 신규는
    // `inserted`가 이미 센다(design.md D3). 이전에는 이 경우도 changed:1로 잘못
    // 셌었다(배치 내 두 번째 행이 방금 insert된 값을 "이전 값"으로 오인했기 때문).
    expect(result).toEqual({ inserted: 1, updated: 1, changed: 0 });
    const { items, total } = repo.listItems();
    expect(total).toBe(1);
    expect(items[0]?.status).toBe("변경"); // 나중 값이 남는다
  });

  it("배치 안에서 같은 키가 여러 번 나와도 changed는 물건 단위로 한 번만, 그리고 배치 시작 전 값과 실제로 다를 때만 센다(finding 6)", () => {
    // 이 물건은 이전 호출에서 이미 저장돼 있었다 — 이번 배치의 "시작 전 저장값"이 있다.
    repo.upsertItems([makeItem({ minBidPrice: 100 })], { now: "2026-01-01T00:00:00.000Z" });

    const result = repo.upsertItems(
      [
        makeItem({ minBidPrice: 200 }), // 배치 시작 전(100)과 다르다
        makeItem({ minBidPrice: 300 }), // 같은 배치 안 두 번째 — 같은 물건, 최종값만 남는다
      ],
      { now: "2026-01-02T00:00:00.000Z" },
    );

    // 물건은 하나뿐이므로 changed도 최대 1 — 배치 안에 몇 번 나왔든 중복 집계하지 않는다.
    expect(result).toEqual({ inserted: 0, updated: 2, changed: 1 });
    expect(repo.listItems().items[0]?.minBidPrice).toBe(300); // 최종값(나중 값)이 남는다
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
        expect.objectContaining({
          field: "minBidPrice",
          oldValue: null,
          newValue: "400000000",
          kind: "baseline",
        }),
        expect.objectContaining({
          field: "failedBidCount",
          oldValue: null,
          newValue: "1",
          kind: "baseline",
        }),
        expect.objectContaining({
          field: "auctionDate",
          oldValue: null,
          newValue: "2026-10-01",
          kind: "baseline",
        }),
        expect.objectContaining({ field: "status", oldValue: null, newValue: "진행", kind: "baseline" }),
      ]),
    );
    for (const change of changes) {
      expect(change.itemId).toBe(itemId);
      expect(change.changedAt).toBe("2026-01-01T00:00:00.000Z");
      expect(change.kind).toBe("baseline"); // 전부 기준점이다 — 실제 변경은 하나도 없다.
    }
  });

  /**
   * 코드 리뷰 finding 1: `kind`가 기준점/실제 변경을 구별하는 유일한 마커임을 직접
   * 확인한다. 기준점 행(kind='baseline')과 실제 변경 행(kind='change')이 같은 물건,
   * 같은 필드에 대해 나란히 존재할 수 있고, `oldValue`만으로는(둘 다 null일 수 있어)
   * 구별이 안 된다는 것까지 함께 고정한다.
   */
  it("기준점 행(kind='baseline')과 실제 변경 행(kind='change')이 명시적으로 구별된다", () => {
    repo.upsertItems([makeItem({ auctionDate: null })], { now: "2026-01-01T00:00:00.000Z" });
    const itemId = repo.listItems().items[0]!.id;
    repo.upsertItems([makeItem({ auctionDate: "2026-11-01" })], { now: "2026-01-02T00:00:00.000Z" });

    const changes = repo.listItemChanges(itemId);
    const baselineRows = changes.filter((c) => c.kind === "baseline");
    const changeRows = changes.filter((c) => c.kind === "change");

    // minBidPrice/failedBidCount/status의 기준점(auctionDate 제외, NULL이라 기준점 없음).
    expect(baselineRows).toHaveLength(3);
    // auctionDate의 null→값 실제 변경 — oldValue는 baselineRows와 똑같이 null이지만
    // kind로만 구별된다.
    expect(changeRows).toEqual([
      expect.objectContaining({ field: "auctionDate", oldValue: null, newValue: "2026-11-01" }),
    ]);
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

  /**
   * 코드 리뷰 finding 1의 핵심 회귀 테스트. `oldValue`는 이 실제 변경도(null→값)
   * 기준점(null→값, D2)과 똑같이 `null`이라 — 이전에는 그 둘을 구별할 방법이 없어서
   * 이 변경이 기준점으로 오인돼 화면·재분석·목록에서 통째로 사라졌다. `kind`가 그
   * 구별을 명시적으로 만들고, 그 구별이 재분석 대상 선정과 `lastChangedAt`에도 실제로
   * 반영되는지까지 확인한다(이전에는 여기서 끝나 버그를 놓쳤다).
   */
  it("null과 값 사이의 변화는 실제 변경(kind='change')으로 기록되고, 재분석 대상이 되며 lastChangedAt에 반영된다", () => {
    repo.upsertItems([makeItem({ auctionDate: null })], { now: "2026-01-01T00:00:00.000Z" });
    const itemId = repo.listItems().items[0]!.id;
    // auctionDate가 NULL이라 기준점 행이 없다.
    expect(repo.listItemChanges(itemId).some((c) => c.field === "auctionDate")).toBe(false);

    repo.upsertItems([makeItem({ auctionDate: "2026-11-01" })], { now: "2026-01-02T00:00:00.000Z" });

    const auctionDateChanges = repo
      .listItemChanges(itemId)
      .filter((c) => c.field === "auctionDate");
    // oldValue는 여전히 null이다(값이 없던 상태에서 왔으니까) — 그래서 kind가 유일한
    // 구별 수단이다. kind가 "change"임을 명시적으로 확인한다("baseline"이 아니다).
    expect(auctionDateChanges).toEqual([
      expect.objectContaining({ oldValue: null, newValue: "2026-11-01", kind: "change" }),
    ]);

    // 재분석 대상 선정: 이 변경 이전에 분석이 있었다면, 이 null→값 변경이 그 분석을
    // 낡게 만들어야 한다 — 기준점으로 취급돼 조용히 무시되면 안 된다.
    repo.insertAnalysis(
      { itemId, body: "old", model: null, promptVersion: "v1" },
      { now: "2026-01-01T12:00:00.000Z" }, // 실제 변경(01-02)보다 이전 분석
    );
    const needsReanalysis = repo.listItems({
      needsAnalysis: true,
      promptVersion: "v1",
      pageSize: 10,
    });
    expect(needsReanalysis.items.map((i) => i.id)).toContain(itemId);

    // lastChangedAt: 목록에서도 이 변경이 "최근 변동"으로 잡혀야 한다.
    const item = repo.listItems({ pageSize: 10 }).items.find((i) => i.id === itemId)!;
    expect(item.lastChangedAt).toBe("2026-01-02T00:00:00.000Z");
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

    // item_changes가 없어 `repo.getItemById`(finding 5로 lastChangedAt 서브쿼리가 그
    // 테이블을 참조한다)는 이제 이 상태에서 쓸 수 없다 — 물건 테이블만 직접 SQL로 확인한다.
    // 물건 쪽 갱신이 롤백됐는지: 실패 전 값 그대로여야 한다.
    const afterRow = db
      .prepare<{ id: number }, { min_bid_price: number | null }>(
        "SELECT min_bid_price FROM items WHERE id = @id",
      )
      .get({ id: itemId });
    expect(afterRow?.min_bid_price).toBe(before?.minBidPrice);
  });

  /**
   * 원자성, 반대 방향(코드 리뷰 finding 7a). 위 테스트는 배치 실패 후 `listItems().total`만
   * 확인했다 — 배치 앞쪽 물건이 이미 쓴 `item_changes` 행까지 롤백되는지는 따로 확인한
   * 적이 없었다. 배치의 두 번째 물건이 실패하도록 만들고, 첫 번째 물건의 실제 변경
   * (item_changes에 새로 쓰였을 행)이 커밋되지 않았는지 직접 확인한다.
   */
  it("배치 중간에 실패하면 그 전에 처리된 물건의 item_changes 행도 함께 롤백된다(원자성, 반대 방향)", () => {
    repo.upsertItems([makeItem()], { now: "2026-01-01T00:00:00.000Z" });
    const itemId = repo.listItems().items[0]!.id;
    const changesBefore = repo.listItemChanges(itemId);

    // 배치의 첫 번째 물건(itemId)은 실제 변경을 만든다 — item_changes에 새 행이 쓰일
    // 것이다. 두 번째 물건은 court가 NULL이라 NOT NULL 제약을 어겨 INSERT/UPDATE
    // 시점에 실패한다(client.test.ts/repository.test.ts의 기존 패턴과 동일).
    const broken = { ...makeItem({ itemNo: "2" }), court: null } as unknown as AuctionItemInput;

    expect(() =>
      repo.upsertItems([makeItem({ minBidPrice: 1 }), broken], {
        now: "2026-01-02T00:00:00.000Z",
      }),
    ).toThrow();

    // 배치가 통째로 롤백됐으므로, 첫 번째 물건의 실제 변경(minBidPrice: 1)에 대한
    // item_changes 행도 커밋되지 않았어야 한다 — 배치 전 이력 그대로다.
    expect(repo.listItemChanges(itemId)).toEqual(changesBefore);
    // 물건 자체의 값도 롤백됐는지 같이 확인한다(위 테스트와 대칭).
    expect(repo.getItemById(itemId)?.minBidPrice).toBe(400_000_000);
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
 * 관심 여부(design.md D6, add-bookmarks-and-feed task 2.1/2.2) — `lastChangedAt`과 같은
 * 방식(스칼라 서브쿼리 컬럼)으로 추가됐다. 이 change에서 가장 회귀 위험이 큰 지점이라
 * "필터·정렬·total이 그대로다"를 별도로 고정한다.
 */
describe("listItems — bookmarked (design.md D6, add-bookmarks-and-feed)", () => {
  it("관심 등록된 물건은 bookmarked=true, 아니면 false다", () => {
    repo.upsertItems([makeItem({ itemNo: "1" }), makeItem({ itemNo: "2" })]);
    const bookmarks = createBookmarksRepository(db);
    const item1 = repo.listItems({ pageSize: 10 }).items.find((item) => item.itemNo === "1")!;
    bookmarks.addBookmark(item1.id);

    const { items } = repo.listItems({ pageSize: 10 });
    expect(items.find((item) => item.itemNo === "1")?.bookmarked).toBe(true);
    expect(items.find((item) => item.itemNo === "2")?.bookmarked).toBe(false);
  });

  it("getItemById도 bookmarked를 채운다", () => {
    repo.upsertItems([makeItem()]);
    const bookmarks = createBookmarksRepository(db);
    const item = repo.listItems({ pageSize: 10 }).items[0]!;
    expect(repo.getItemById(item.id)?.bookmarked).toBe(false);

    bookmarks.addBookmark(item.id);
    expect(repo.getItemById(item.id)?.bookmarked).toBe(true);
  });

  it("[회귀] 이 컬럼이 있어도 필터·정렬·total은 그대로다 — 관심 여부와 무관하다", () => {
    repo.upsertItems([
      makeItem({ itemNo: "1", auctionDate: "2026-03-03" }),
      makeItem({ itemNo: "2", auctionDate: "2026-01-01" }),
    ]);
    const bookmarks = createBookmarksRepository(db);
    const item1 = repo.listItems({ pageSize: 10 }).items.find((item) => item.itemNo === "1")!;
    bookmarks.addBookmark(item1.id);

    const bookmarkedResult = repo.listItems({ sort: "auctionDate", direction: "asc", pageSize: 10 });
    // 관심 등록 전과 total·정렬 순서가 동일해야 한다.
    const unbookmarked = createRepository(openDatabase(":memory:"));
    unbookmarked.upsertItems([
      makeItem({ itemNo: "1", auctionDate: "2026-03-03" }),
      makeItem({ itemNo: "2", auctionDate: "2026-01-01" }),
    ]);
    const baselineResult = unbookmarked.listItems({
      sort: "auctionDate",
      direction: "asc",
      pageSize: 10,
    });

    expect(bookmarkedResult.total).toBe(baselineResult.total);
    expect(bookmarkedResult.items.map((item) => item.itemNo)).toEqual(
      baselineResult.items.map((item) => item.itemNo),
    );
  });
});

/**
 * 재분석 대상 판정(design.md D4). 세 조건의 OR — 분석 없음 / 최신 분석 이후 실제 변경 /
 * 최신 분석의 prompt_version이 요청 버전과 다름. `analyzed=false`의 의미(분석 행 없음)는
 * 이 필터가 있어도 바뀌지 않아야 한다(회귀).
 */
describe("listItems — needsAnalysis (design.md D4, 코드 리뷰 finding 2로 조건 1 제거)", () => {
  it("[회귀] needsAnalysis와 무관하게 analyzed=false는 여전히 '분석 없음'만 뜻한다", () => {
    repo.upsertItems([makeItem({ itemNo: "1" }), makeItem({ itemNo: "2" })], {
      now: "2026-01-01T00:00:00.000Z",
    });
    const [item1, item2] = repo.listItems({ pageSize: 10 }).items;
    repo.insertAnalysis(
      { itemId: item1!.id, body: "x", model: null, promptVersion: "v1" },
      { now: "2026-01-02T00:00:00.000Z" },
    );
    // item1은 분석 이후 값이 바뀌어 재분석 대상이 되지만, "분석 자체는 있다"는 사실은
    // 바뀌지 않는다 — analyzed=false 결과에서 계속 빠져야 한다.
    repo.upsertItems([makeItem({ itemNo: "1", minBidPrice: 1 })], {
      now: "2026-01-03T00:00:00.000Z",
    });

    const unanalyzed = repo.listItems({ analyzed: false, pageSize: 10 });
    expect(unanalyzed.items.map((item) => item.id)).toEqual([item2!.id]);

    const needsReanalysis = repo.listItems({
      needsAnalysis: true,
      promptVersion: "v1",
      pageSize: 10,
    });
    const ids = needsReanalysis.items.map((item) => item.id);
    expect(ids).toContain(item1!.id); // 실제 변경이 있어 대상
    // item2는 분석 자체가 없다 — finding 2 수정 이후로는 이 경로(재분석 대상 조회)에
    // 섞이지 않는다. 미분석 물건은 analyzed=false가 전담한다(스펙: "미분석 물건은
    // 재분석 대상에 섞이지 않음").
    expect(ids).not.toContain(item2!.id);
  });

  it("스펙 시나리오 — 미분석 물건은 재분석 대상에 섞이지 않음: 분석이 아예 없으면 재분석 대상이 아니다(finding 2)", () => {
    repo.upsertItems([makeItem()]);
    const item = repo.listItems({ pageSize: 10 }).items[0]!;

    // 이전 버전은 "분석 행이 아예 없음"도 이 필터의 한 조건(OR)이라 미분석 물건이
    // 여기 섞여 들어왔다 — 재분석 후보 정렬(analyzed_at ASC)에서 그런 물건은 NULL로
    // 취급되고 SQLite가 ASC에서 NULL을 맨 앞에 둬서, 미분석 물건이 쌓이면 진짜 재분석
    // 대상이 페이지에서 밀려났다. 이제는 분석 행이 있어야만(EXISTS) 이 필터를 통과한다.
    const result = repo.listItems({ needsAnalysis: true, promptVersion: "v1", pageSize: 10 });
    expect(result.items.map((i) => i.id)).not.toContain(item.id);
  });

  it("미분석 물건 다수 + 실제 재분석 대상 1건이 있어도 재분석 대상만 반환된다(finding 2, 리뷰가 지적한 회귀 시나리오)", () => {
    // 미분석 물건 여러 건 — 재분석 후보 정렬(analyzed_at ASC)에서 예전에는 이 물건들이
    // NULL로 맨 앞을 차지해 진짜 재분석 대상을 밀어냈다.
    repo.upsertItems(
      Array.from({ length: 5 }, (_, i) => makeItem({ itemNo: `u${i + 1}` })),
      { now: "2026-01-01T00:00:00.000Z" },
    );
    // 실제 재분석 대상: 분석 완료 후 실제 변경.
    repo.upsertItems([makeItem({ itemNo: "target" })], { now: "2026-01-01T00:00:00.000Z" });
    const target = repo.listItems({ pageSize: 10 }).items.find((i) => i.itemNo === "target")!;
    repo.insertAnalysis(
      { itemId: target.id, body: "x", model: null, promptVersion: "v1" },
      { now: "2026-01-02T00:00:00.000Z" },
    );
    repo.upsertItems([makeItem({ itemNo: "target", minBidPrice: 1 })], {
      now: "2026-01-03T00:00:00.000Z",
    });

    // pageSize를 작게 줘도(재분석 한도가 작은 실제 운영 상황을 흉내) target이 나와야 한다 —
    // 미분석 물건이 결과에 아예 없으므로 정렬·페이지 크기와 무관하게 target을 밀어낼 수 없다.
    const result = repo.listItems({ needsAnalysis: true, promptVersion: "v1", pageSize: 2 });
    expect(result.items.map((i) => i.id)).toEqual([target.id]);
  });

  it("스펙 시나리오 — 변경된 물건 재분석: 최신 분석 이후 실제 변경이 있으면 대상이다(조건 2)", () => {
    repo.upsertItems([makeItem()], { now: "2026-01-01T00:00:00.000Z" });
    const item = repo.listItems({ pageSize: 10 }).items[0]!;
    repo.insertAnalysis(
      { itemId: item.id, body: "x", model: null, promptVersion: "v1" },
      { now: "2026-01-02T00:00:00.000Z" },
    );
    repo.upsertItems([makeItem({ minBidPrice: 1 })], { now: "2026-01-03T00:00:00.000Z" });

    const result = repo.listItems({ needsAnalysis: true, promptVersion: "v1", pageSize: 10 });
    expect(result.items.map((i) => i.id)).toContain(item.id);
  });

  it("스펙 시나리오 — 프롬프트 버전 갱신에 따른 재분석: 변경이 없어도 버전이 다르면 대상이다(조건 3)", () => {
    repo.upsertItems([makeItem()], { now: "2026-01-01T00:00:00.000Z" });
    const item = repo.listItems({ pageSize: 10 }).items[0]!;
    repo.insertAnalysis(
      { itemId: item.id, body: "x", model: null, promptVersion: "v1" },
      { now: "2026-01-02T00:00:00.000Z" },
    );

    const sameVersion = repo.listItems({ needsAnalysis: true, promptVersion: "v1", pageSize: 10 });
    expect(sameVersion.items.map((i) => i.id)).not.toContain(item.id);

    const differentVersion = repo.listItems({
      needsAnalysis: true,
      promptVersion: "v2",
      pageSize: 10,
    });
    expect(differentVersion.items.map((i) => i.id)).toContain(item.id);
  });

  it("버전을 되돌려도(v2→v1) 다르면 대상이다 — 같음/다름만 본다(세만틱 비교가 아니다, design.md D4)", () => {
    repo.upsertItems([makeItem()], { now: "2026-01-01T00:00:00.000Z" });
    const item = repo.listItems({ pageSize: 10 }).items[0]!;
    repo.insertAnalysis(
      { itemId: item.id, body: "x", model: null, promptVersion: "v2" },
      { now: "2026-01-02T00:00:00.000Z" },
    );

    const result = repo.listItems({ needsAnalysis: true, promptVersion: "v1", pageSize: 10 });
    expect(result.items.map((i) => i.id)).toContain(item.id);
  });

  it("스펙 시나리오 — 변경 없고 버전도 같은 물건: 재분석 대상이 아니다", () => {
    repo.upsertItems([makeItem()], { now: "2026-01-01T00:00:00.000Z" });
    const item = repo.listItems({ pageSize: 10 }).items[0]!;
    repo.insertAnalysis(
      { itemId: item.id, body: "x", model: null, promptVersion: "v1" },
      { now: "2026-01-02T00:00:00.000Z" },
    );

    const result = repo.listItems({ needsAnalysis: true, promptVersion: "v1", pageSize: 10 });
    expect(result.items.map((i) => i.id)).not.toContain(item.id);
  });

  it("경계: 최신 분석보다 이전의 변경은 재분석 대상으로 만들지 않는다(그 분석이 이미 반영했다)", () => {
    repo.upsertItems([makeItem()], { now: "2026-01-01T00:00:00.000Z" }); // 기준점
    repo.upsertItems([makeItem({ minBidPrice: 1 })], { now: "2026-01-02T00:00:00.000Z" }); // 실제 변경
    const item = repo.listItems({ pageSize: 10 }).items[0]!;
    // 분석이 그 변경 이후에 이뤄졌다.
    repo.insertAnalysis(
      { itemId: item.id, body: "x", model: null, promptVersion: "v1" },
      { now: "2026-01-03T00:00:00.000Z" },
    );

    const result = repo.listItems({ needsAnalysis: true, promptVersion: "v1", pageSize: 10 });
    expect(result.items.map((i) => i.id)).not.toContain(item.id);
  });

  it("경계: 변경 시각이 분석 시각과 정확히 같으면 재분석 대상으로 만들지 않는다(hardening-round1 task 4.1 — 화면 쪽 analysis-freshness.test.ts의 같은 경계 테스트를 SQL 쪽에도 짝으로 둔다)", () => {
    repo.upsertItems([makeItem()], { now: "2026-01-01T00:00:00.000Z" }); // 기준점
    const SAME_INSTANT = "2026-01-02T00:00:00.000Z";
    // 실제 변경과 분석이 정확히 같은 시각에 기록된다 — NEEDS_ANALYSIS_PREDICATE는
    // `changed_at > analyzed_at`(초과)를 쓰므로 같은 시각은 "이미 반영됨"으로 봐야 한다.
    repo.upsertItems([makeItem({ minBidPrice: 1 })], { now: SAME_INSTANT });
    const item = repo.listItems({ pageSize: 10 }).items[0]!;
    repo.insertAnalysis(
      { itemId: item.id, body: "x", model: null, promptVersion: "v1" },
      { now: SAME_INSTANT },
    );

    const result = repo.listItems({ needsAnalysis: true, promptVersion: "v1", pageSize: 10 });
    expect(result.items.map((i) => i.id)).not.toContain(item.id);
  });

  it("기준점 행(old_value IS NULL)은 재분석 대상으로 만들지 않는다(design.md D2)", () => {
    repo.upsertItems([makeItem()], { now: "2026-01-01T00:00:00.000Z" }); // 기준점만 존재
    const item = repo.listItems({ pageSize: 10 }).items[0]!;
    repo.insertAnalysis(
      { itemId: item.id, body: "x", model: null, promptVersion: "v1" },
      { now: "2026-01-02T00:00:00.000Z" }, // 기준점(2026-01-01)보다 나중
    );

    const result = repo.listItems({ needsAnalysis: true, promptVersion: "v1", pageSize: 10 });
    expect(result.items.map((i) => i.id)).not.toContain(item.id);
  });

  it("재분석 후보는 가장 오래 분석된 것부터 정렬된다(analyzed_at ASC, design.md D5)", () => {
    repo.upsertItems([
      makeItem({ itemNo: "1" }),
      makeItem({ itemNo: "2" }),
      makeItem({ itemNo: "3" }),
    ]);
    const items = repo.listItems({ pageSize: 10 }).items;
    const idOf = (no: string) => items.find((item) => item.itemNo === no)!.id;

    repo.insertAnalysis(
      { itemId: idOf("2"), body: "x", model: null, promptVersion: "v0" },
      { now: "2026-01-05T00:00:00.000Z" },
    );
    repo.insertAnalysis(
      { itemId: idOf("1"), body: "x", model: null, promptVersion: "v0" },
      { now: "2026-01-01T00:00:00.000Z" },
    );
    repo.insertAnalysis(
      { itemId: idOf("3"), body: "x", model: null, promptVersion: "v0" },
      { now: "2026-01-10T00:00:00.000Z" },
    );
    // 셋 다 프롬프트 버전이 달라 재분석 대상이다 — 정렬 순서만 확인한다.
    const result = repo.listItems({ needsAnalysis: true, promptVersion: "v1", pageSize: 10 });
    expect(result.items.map((item) => item.itemNo)).toEqual(["1", "2", "3"]);
  });

  it("sort/direction을 줘도 needsAnalysis 모드에서는 analyzed_at ASC로 고정된다", () => {
    repo.upsertItems([makeItem({ itemNo: "1" }), makeItem({ itemNo: "2" })]);
    const items = repo.listItems({ pageSize: 10 }).items;
    const idOf = (no: string) => items.find((item) => item.itemNo === no)!.id;

    repo.insertAnalysis(
      { itemId: idOf("2"), body: "x", model: null, promptVersion: "v0" },
      { now: "2026-01-01T00:00:00.000Z" },
    );
    repo.insertAnalysis(
      { itemId: idOf("1"), body: "x", model: null, promptVersion: "v0" },
      { now: "2026-01-05T00:00:00.000Z" },
    );

    const result = repo.listItems({
      needsAnalysis: true,
      promptVersion: "v1",
      sort: "minBidPrice",
      direction: "desc",
      pageSize: 10,
    });
    // sort=minBidPrice desc를 따랐다면 순서가 달랐을 것 — analyzed_at asc(2번이 먼저)를 확인한다.
    expect(result.items.map((item) => item.itemNo)).toEqual(["2", "1"]);
  });

  it("promptVersion 없이 needsAnalysis:true를 요청하면 저장소가 던진다(API 계층 없이 직접 호출해도 방어)", () => {
    repo.upsertItems([makeItem()]);
    expect(() => repo.listItems({ needsAnalysis: true, pageSize: 10 })).toThrow(/promptVersion/);
  });

  it("지원하지 않는 needsAnalysis 값(false)은 던진다(sort 화이트리스트와 같은 방어)", () => {
    expect(() => repo.listItems({ needsAnalysis: false, pageSize: 10 })).toThrow(
      /지원하지 않는 needsAnalysis/,
    );
  });

  /**
   * 재분석 쿨다운(코드 리뷰 finding 3). 소스가 감시 필드를 회차마다 뒤집어 보고하면
   * 매 회차가 유효한 변경으로 기록돼 재분석이 무한히 유발될 수 있다 — 회차당 건수
   * 제한(`maxReanalysisPerRun`)만으로는 그 물건이 매 회차 한도를 계속 차지하는 것을
   * 막지 못한다. 최신 분석이 쿨다운보다 최근이면 실제 변경이 있어도 대상에서 빠져야
   * 한다.
   */
  describe("재분석 쿨다운 (reanalysisCooldownHours, finding 3)", () => {
    it("최신 분석이 쿨다운 이내면 실제 변경이 있어도 재분석 대상에서 제외된다", () => {
      repo.upsertItems([makeItem()], { now: "2026-01-01T00:00:00.000Z" });
      const item = repo.listItems({ pageSize: 10 }).items[0]!;
      repo.insertAnalysis(
        { itemId: item.id, body: "x", model: null, promptVersion: "v1" },
        { now: "2026-01-02T00:00:00.000Z" },
      );
      // 분석 3시간 후 실제 변경 — 조건 자체는(변경 있음) 충족한다.
      repo.upsertItems([makeItem({ minBidPrice: 1 })], { now: "2026-01-02T03:00:00.000Z" });

      // "지금"을 분석 12시간 후로 고정 — 24시간 쿨다운 안이다.
      const result = repo.listItems(
        { needsAnalysis: true, promptVersion: "v1", reanalysisCooldownHours: 24, pageSize: 10 },
        { now: "2026-01-02T12:00:00.000Z" },
      );
      expect(result.items.map((i) => i.id)).not.toContain(item.id);
    });

    it("쿨다운이 지나면 같은 실제 변경이 다시 재분석 대상이 된다", () => {
      repo.upsertItems([makeItem()], { now: "2026-01-01T00:00:00.000Z" });
      const item = repo.listItems({ pageSize: 10 }).items[0]!;
      repo.insertAnalysis(
        { itemId: item.id, body: "x", model: null, promptVersion: "v1" },
        { now: "2026-01-02T00:00:00.000Z" },
      );
      repo.upsertItems([makeItem({ minBidPrice: 1 })], { now: "2026-01-02T03:00:00.000Z" });

      // "지금"을 분석 25시간 후로 고정 — 24시간 쿨다운이 지났다.
      const result = repo.listItems(
        { needsAnalysis: true, promptVersion: "v1", reanalysisCooldownHours: 24, pageSize: 10 },
        { now: "2026-01-03T01:00:00.000Z" },
      );
      expect(result.items.map((i) => i.id)).toContain(item.id);
    });

    it("reanalysisCooldownHours를 생략하면 쿨다운을 적용하지 않는다(기존 동작과 동일, 하위 호환)", () => {
      repo.upsertItems([makeItem()], { now: "2026-01-01T00:00:00.000Z" });
      const item = repo.listItems({ pageSize: 10 }).items[0]!;
      repo.insertAnalysis(
        { itemId: item.id, body: "x", model: null, promptVersion: "v1" },
        { now: "2026-01-02T00:00:00.000Z" },
      );
      repo.upsertItems([makeItem({ minBidPrice: 1 })], { now: "2026-01-02T03:00:00.000Z" });

      const result = repo.listItems(
        { needsAnalysis: true, promptVersion: "v1", pageSize: 10 },
        { now: "2026-01-02T04:00:00.000Z" }, // 분석 4시간 후 — 쿨다운이 있었다면 걸렸을 시점
      );
      expect(result.items.map((i) => i.id)).toContain(item.id);
    });

    it("음수 reanalysisCooldownHours는 던진다(다른 잘못된 값과 같은 방어)", () => {
      repo.upsertItems([makeItem()]);
      expect(() =>
        repo.listItems({
          needsAnalysis: true,
          promptVersion: "v1",
          reanalysisCooldownHours: -1,
          pageSize: 10,
        }),
      ).toThrow(/reanalysisCooldownHours/);
    });
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

    it("복합 문자열의 개별 토큰만으로도 매칭된다(계약 변경, ux-overhaul-phase2 design.md D2)", () => {
      // 이전 계약(정확 일치)에서는 usageTypes: ["상가"]가 0건이었다 — "상가,오피스텔,근린시설"과
      // 정확히 같은 문자열이 아니었기 때문이다. 이제는 토큰 단위로 걸려 "3"이 나온다 —
      // 같은 `usage=오피스텔` 요청이 이전보다 넓은 결과를 반환한다는 의도된 계약 변경이다.
      expect(found({ usageTypes: ["상가"] })).toEqual(["3"]);
      expect(found({ usageTypes: ["오피스텔"] })).toEqual(["3"]);
      expect(found({ usageTypes: ["근린시설"] })).toEqual(["3"]);
      // 복합 문자열 전체를 그대로 줘도(기존처럼) 여전히 매칭된다 — 앞뒤 구분자를 붙인
      // 패턴이 원본 문자열 전체와도 일치한다.
      expect(found({ usageTypes: ["상가,오피스텔,근린시설"] })).toEqual(["3"]);
    });

    it("부분 문자열 오탐을 피한다 — \"오피스텔형\"은 \"오피스텔\" 토큰과 다르다(design.md D2)", () => {
      repo.upsertItems([
        makeItem({ itemNo: "6", usageType: "오피스텔형", auctionDate: "2026-05-05" }),
      ]);
      expect(found({ usageTypes: ["오피스텔"] })).not.toContain("6");
      expect(found({ usageTypes: ["오피스텔형"] })).toEqual(["6"]);
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

/**
 * 지역·기일·관심·면적당가격 필터/정렬 데이터셋(ux-overhaul-phase2). "listItems 필터·정렬"의
 * 기존 5건 데이터셋과 별개로 둔다 — sido/sigungu/minArea/maxArea/북마크까지 얽히면 기존
 * 스위트가 읽기 어려워진다.
 *
 * `now`는 항상 2026-06-01(UTC 자정 = 한국시간 같은 날 09:00)로 고정해 "지난 기일 제외"를
 * 결정적으로 검증한다.
 *
 * | itemNo | 시/도      | 시/군/구 | 매각기일    | 관심 | 최저가 | 면적(㎡) |
 * |--------|------------|----------|-------------|------|--------|----------|
 * | 1      | 서울특별시 | 관악구   | 2026-01-01(과거) | O | 100  | 10 |
 * | 2      | 서울특별시 | 강남구   | 2026-12-31(미래) | X | 200  | 20 |
 * | 3      | 경기도     | 수원시   | (없음)      | X | 300  | (없음) |
 * | 4      | (없음)     | (없음)   | 2026-06-01(오늘, 경계) | O | (없음) | 5 |
 */
describe("listItems — 지역/기일/관심/면적당가격 (ux-overhaul-phase2)", () => {
  const NOW = "2026-06-01T00:00:00.000Z";

  beforeEach(() => {
    repo.upsertItems([
      makeItem({
        itemNo: "1",
        sido: "서울특별시",
        sigungu: "관악구",
        auctionDate: "2026-01-01",
        minBidPrice: 100,
        minArea: 10,
        maxArea: 10,
      }),
      makeItem({
        itemNo: "2",
        sido: "서울특별시",
        sigungu: "강남구",
        auctionDate: "2026-12-31",
        minBidPrice: 200,
        minArea: 20,
        maxArea: 20,
      }),
      makeItem({
        itemNo: "3",
        sido: "경기도",
        sigungu: "수원시",
        auctionDate: null,
        minBidPrice: 300,
      }),
      makeItem({
        itemNo: "4",
        sido: null,
        sigungu: null,
        auctionDate: "2026-06-01",
        minBidPrice: null,
        minArea: 5,
        maxArea: 5,
      }),
    ]);
    const bookmarks = createBookmarksRepository(db);
    const byItemNo = new Map(
      repo.listItems({ pageSize: 10 }).items.map((item) => [item.itemNo, item.id]),
    );
    bookmarks.addBookmark(byItemNo.get("1")!);
    bookmarks.addBookmark(byItemNo.get("4")!);
  });

  function found(query: Parameters<AuctionRepository["listItems"]>[0]): string[] {
    return repo.listItems({ pageSize: 10, ...query }, { now: NOW }).items.map((item) => item.itemNo);
  }

  describe("지역 필터(sido/sigungu) — tasks.md 1.1~1.4", () => {
    it("시/도로 좁히면 그 지역 물건만 남고 total도 그 기준이다", () => {
      const result = repo.listItems({ sidoValues: ["서울특별시"], pageSize: 10 });
      expect(result.items.map((item) => item.itemNo).sort()).toEqual(["1", "2"]);
      expect(result.total).toBe(2);
    });

    it("시/군/구로 더 좁힐 수 있다", () => {
      expect(found({ sigunguValues: ["관악구"] })).toEqual(["1"]);
    });

    it("여러 값을 주면 OR로 걸린다", () => {
      expect(found({ sigunguValues: ["관악구", "강남구"] }).sort()).toEqual(["1", "2"]);
    });

    it("시/도·시/군/구가 없는(NULL) 물건은 지역 필터에 걸리지 않는다", () => {
      expect(found({ sidoValues: ["서울특별시", "경기도"] })).not.toContain("4");
    });

    it("빈 배열이면 필터를 걸지 않는다", () => {
      expect(repo.listItems({ sidoValues: [], pageSize: 10 }).total).toBe(4);
    });

    it("0건일 때 올바른 빈 상태로 이어진다(0.1 — hasActiveFilters와 짝)", () => {
      const result = repo.listItems({ sidoValues: ["존재하지않는시도"], pageSize: 10 });
      expect(result.total).toBe(0);
      expect(hasActiveFilters({ sidoValues: ["존재하지않는시도"] })).toBe(true);
    });

    it("[회귀] 지역을 지정하지 않으면 이전과 동일한 결과·건수다(tasks.md 1.4)", () => {
      expect(repo.listItems({ pageSize: 10 }).total).toBe(4);
      expect(
        repo.listItems({ pageSize: 10, sidoValues: undefined, sigunguValues: undefined }),
      ).toEqual(repo.listItems({ pageSize: 10 }));
    });
  });

  describe("매각기일 범위 필터 — tasks.md 3.1~3.3", () => {
    it("from/to로 좁힐 수 있고 경계값을 포함한다", () => {
      expect(found({ auctionDateFrom: "2026-01-01", auctionDateTo: "2026-01-01" })).toEqual(["1"]);
      expect(found({ auctionDateFrom: "2026-06-01" }).sort()).toEqual(["2", "4"]);
    });

    it("매각기일이 없는(NULL) 물건은 기일 범위 필터에서 제외된다", () => {
      expect(found({ auctionDateFrom: "2000-01-01" })).not.toContain("3");
    });

    it("\"지난 기일 제외\"는 오늘(한국시간) 이후만 남기고, 오늘 당일은 포함한다(경계)", () => {
      // now=2026-06-01. 1번(2026-01-01)만 과거라 제외되고, 3번(NULL)도 비교식이 참이 되지
      // 않아 제외된다. 4번(오늘 당일)은 포함된다 — >= 비교라 경계 포함.
      expect(found({ excludePastAuctions: true }).sort()).toEqual(["2", "4"]);
    });

    it("[회귀] excludePastAuctions를 지정하지 않으면 지난 기일 물건도 그대로 포함된다(opt-in, tasks.md 3.2)", () => {
      expect(found({}).sort()).toEqual(["1", "2", "3", "4"]);
    });

    it("0건일 때 올바른 빈 상태로 이어진다(0.1)", () => {
      expect(repo.listItems({ auctionDateFrom: "2099-01-01", pageSize: 10 }, { now: NOW }).total).toBe(0);
      expect(hasActiveFilters({ auctionDateFrom: "2099-01-01" })).toBe(true);
    });

    it("페이지 이동 후에도 조건이 유지된다(0.2) — total은 페이지와 무관하게 필터 기준", () => {
      const page1 = repo.listItems({ excludePastAuctions: true, pageSize: 1, page: 1 }, { now: NOW });
      const page2 = repo.listItems({ excludePastAuctions: true, pageSize: 1, page: 2 }, { now: NOW });
      expect(page1.total).toBe(2);
      expect(page2.total).toBe(2);
      expect([...page1.items, ...page2.items].map((i) => i.itemNo).sort()).toEqual(["2", "4"]);
    });
  });

  describe("관심 필터(bookmarked) — tasks.md 4.1~4.2", () => {
    it("관심만 보기는 담긴 물건만 남긴다", () => {
      expect(found({ bookmarked: true }).sort()).toEqual(["1", "4"]);
    });

    it("관심 제외는 담기지 않은 물건만 남긴다", () => {
      expect(found({ bookmarked: false }).sort()).toEqual(["2", "3"]);
    });

    it("생략하면 전체가 나온다(opt-in)", () => {
      expect(found({}).sort()).toEqual(["1", "2", "3", "4"]);
    });

    it("관심 표시 컬럼(bookmarked)은 여전히 total에 영향을 주지 않는다(design.md D4, D6 보장 유지)", () => {
      // 필터를 걸지 않은 채로도 각 행의 bookmarked 표시는 정확하다 — BOOKMARKED_EXPR가
      // WHERE에 관여하지 않는다는 기존 보장이 새 EXISTS 필터 추가로 깨지지 않았다.
      const all = repo.listItems({ pageSize: 10 });
      expect(all.total).toBe(4);
      const byItemNo = new Map(all.items.map((item) => [item.itemNo, item.bookmarked]));
      expect(byItemNo.get("1")).toBe(true);
      expect(byItemNo.get("2")).toBe(false);
      expect(byItemNo.get("4")).toBe(true);
    });

    it("0건일 때 올바른 빈 상태로 이어진다(0.1)", () => {
      const bookmarks = createBookmarksRepository(db);
      const target = repo.listItems({ pageSize: 10 }).items.find((i) => i.itemNo === "1")!;
      bookmarks.removeBookmark(target.id);
      const target4 = repo.listItems({ pageSize: 10 }).items.find((i) => i.itemNo === "4")!;
      bookmarks.removeBookmark(target4.id);
      expect(repo.listItems({ bookmarked: true, pageSize: 10 }).total).toBe(0);
      expect(hasActiveFilters({ bookmarked: true })).toBe(true);
    });

    it("페이지 이동 후에도 조건이 유지된다(0.2)", () => {
      const page1 = repo.listItems({ bookmarked: true, pageSize: 1, page: 1 });
      const page2 = repo.listItems({ bookmarked: true, pageSize: 1, page: 2 });
      expect(page1.total).toBe(2);
      expect(page2.total).toBe(2);
    });
  });

  describe("면적당 가격 정렬(pricePerArea) — tasks.md 6.1~6.4", () => {
    // 최저가/㎡: 1번=100/10=10, 2번=200/20=10(동률 → id 안정 정렬), 3번=최저가 있지만
    // 면적 없음 → NULL, 4번=최저가 없음 → NULL.
    it("오름/내림차순 모두 면적을 계산할 수 없는 물건은 방향과 무관하게 뒤로 간다", () => {
      expect(found({ sort: "pricePerArea", direction: "asc" })).toEqual(["1", "2", "3", "4"]);
      expect(found({ sort: "pricePerArea", direction: "desc" })).toEqual(["1", "2", "3", "4"]);
    });

    it("동률이면 id로 안정 정렬된다(1번과 2번은 면적당 가격이 같다)", () => {
      expect(found({ sort: "pricePerArea", direction: "asc" }).slice(0, 2)).toEqual(["1", "2"]);
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

  it("복합 문자열을 쉼표로 쪼개 개별 토큰으로 만들고 중복을 제거한다(design.md D2)", () => {
    repo.upsertItems([
      makeItem({ itemNo: "1", usageType: "상가,오피스텔,근린시설" }),
      makeItem({ itemNo: "2", usageType: "오피스텔" }), // 위 복합 문자열의 토큰과 중복
      makeItem({ itemNo: "3", usageType: "아파트" }),
    ]);

    expect(repo.listUsageTypes()).toEqual(["근린시설", "상가", "아파트", "오피스텔"]);
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

describe("listAnalyses", () => {
  let itemId: number;

  beforeEach(() => {
    repo.upsertItems([makeItem()]);
    itemId = repo.listItems().items[0]!.id;
  });

  it("분석이 없으면 빈 배열이다", () => {
    expect(repo.listAnalyses(itemId)).toEqual([]);
  });

  it("최신순(analyzed_at DESC)으로 전부 돌려준다 — 재분석이 이전 분석을 지우지 않는다(spec '이전 분석 보존')", () => {
    repo.insertAnalysis(
      { itemId, body: "old", model: null, promptVersion: "v1" },
      { now: "2026-01-01T00:00:00.000Z" },
    );
    repo.insertAnalysis(
      { itemId, body: "new", model: null, promptVersion: "v2" },
      { now: "2026-02-01T00:00:00.000Z" },
    );

    const analyses = repo.listAnalyses(itemId);
    expect(analyses).toHaveLength(2);
    expect(analyses.map((a) => a.body)).toEqual(["new", "old"]);
    expect(analyses.map((a) => a.promptVersion)).toEqual(["v2", "v1"]);
  });

  it("다른 물건의 분석과 섞이지 않는다", () => {
    repo.upsertItems([makeItem({ itemNo: "2" })]);
    const other = repo.listItems({ pageSize: 10 }).items.find((item) => item.itemNo === "2")!;
    repo.insertAnalysis({ itemId, body: "a", model: null, promptVersion: "v1" });
    repo.insertAnalysis({ itemId: other.id, body: "b", model: null, promptVersion: "v1" });

    expect(repo.listAnalyses(itemId).map((a) => a.body)).toEqual(["a"]);
    expect(repo.listAnalyses(other.id).map((a) => a.body)).toEqual(["b"]);
  });

  it("존재하지 않는 물건 id도 오류 없이 빈 배열을 돌려준다", () => {
    expect(repo.listAnalyses(999_999)).toEqual([]);
  });

  /**
   * 코드 리뷰 finding 3b: 물건 상세 페이지가 이 메서드를 한도 없이 불러 전체를 렌더링하면,
   * 감시 필드가 자주 뒤집히는 물건 하나가 재분석을 수백 건 쌓아 페이지 하나가 무거워진다.
   * `limit`으로 렌더링 대상만 잘라 받을 수 있어야 한다.
   */
  it("limit을 주면 최신순으로 그 건수만 잘라서 돌려준다", () => {
    for (let i = 0; i < 5; i += 1) {
      repo.insertAnalysis(
        { itemId, body: `분석 ${i}`, model: null, promptVersion: "v1" },
        { now: `2026-01-0${i + 1}T00:00:00.000Z` },
      );
    }

    const limited = repo.listAnalyses(itemId, { limit: 2 });
    expect(limited).toHaveLength(2);
    // 최신순(analyzed_at DESC)이므로 가장 나중에 저장한 것부터.
    expect(limited.map((a) => a.body)).toEqual(["분석 4", "분석 3"]);
  });

  it("limit을 생략하면 이전과 같이 전체를 돌려준다(하위 호환)", () => {
    for (let i = 0; i < 3; i += 1) {
      repo.insertAnalysis(
        { itemId, body: `분석 ${i}`, model: null, promptVersion: "v1" },
        { now: `2026-01-0${i + 1}T00:00:00.000Z` },
      );
    }
    expect(repo.listAnalyses(itemId)).toHaveLength(3);
  });
});

describe("countAnalyses", () => {
  it("전체 건수를 돌려준다 — listAnalyses에 limit을 줘도 이 값은 잘리지 않는다", () => {
    repo.upsertItems([makeItem()]);
    const itemId = repo.listItems().items[0]!.id;

    for (let i = 0; i < 4; i += 1) {
      repo.insertAnalysis(
        { itemId, body: `분석 ${i}`, model: null, promptVersion: "v1" },
        { now: `2026-01-0${i + 1}T00:00:00.000Z` },
      );
    }

    expect(repo.countAnalyses(itemId)).toBe(4);
    expect(repo.listAnalyses(itemId, { limit: 1 })).toHaveLength(1);
  });

  it("분석이 없으면 0이다", () => {
    repo.upsertItems([makeItem()]);
    const itemId = repo.listItems().items[0]!.id;
    expect(repo.countAnalyses(itemId)).toBe(0);
  });

  it("존재하지 않는 물건 id도 오류 없이 0을 돌려준다", () => {
    expect(repo.countAnalyses(999_999)).toBe(0);
  });
});
