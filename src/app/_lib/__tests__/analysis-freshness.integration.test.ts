import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDatabase, type Db } from "@/lib/db/client";
import { createRepository, type AuctionRepository } from "@/lib/db/repository";
import type { AuctionItemInput } from "@/lib/domain";

import { isRealChange } from "../change-history";
import { determineAnalysisFreshness } from "../analysis-freshness";

/**
 * `determineAnalysisFreshness`(화면)와 `NEEDS_ANALYSIS_PREDICATE`(워커가 쓰는
 * `repository.listItems({ needsAnalysis: true })` SQL)가 **같은 실제 저장소 데이터**에
 * 대해 같은 답을 내는지 확인한다(design.md D3: "판정은 이미 있는 needsAnalysis 로직을
 * 재사용한다. 새 판정 규칙을 만들지 않는다 — 두 벌이 되면 화면과 워커가 다른 답을 낸다").
 *
 * 단위 테스트(analysis-freshness.test.ts)는 `determineAnalysisFreshness` 자신의 로직만
 * 손으로 만든 입력으로 확인한다 — 그 입력이 실제 저장소가 만들어내는 값과 같다는 보장은
 * 없다. 이 파일은 실제 `AuctionRepository`(인메모리 SQLite)를 구동해 두 판정을 같은
 * 데이터에 대해 나란히 돌리고 어긋나는 입력이 없는지 확인한다 — 이 프로젝트에서 가짜
 * 데이터만으로 검증해 294개 테스트를 통과한 채 배포된 결함이 실제로 있었다.
 *
 * 쿨다운은 의도적 예외다(analysis-freshness.ts 주석, design.md D3): SQL의
 * `needsAnalysis=true`는 쿨다운 중인 물건을 "이번 회차 재분석 후보"에서 제외하지만,
 * 화면의 `determineAnalysisFreshness`는 쿨다운을 모른다 — 사용자에게는 "옛 값 기준
 * 분석"이라는 사실이 쿨다운 여부와 무관하게 그대로 보여야 하기 때문이다. 그래서 이
 * 갈래는 "일치"가 아니라 "의도된 불일치"로 별도 검증한다.
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

const CURRENT_PROMPT_VERSION = "v1";

/**
 * 주어진 물건이 실제 저장소 기준으로 "화면 판정"과 "SQL 재분석 대상 판정(쿨다운 제외)"이
 * 일치하는지 확인한다. `reanalysisCooldownHours`를 주지 않아 SQL도 쿨다운을 적용하지
 * 않은 상태로 비교한다 — 쿨다운 자체는 별도 describe에서 확인한다.
 */
function assertAgreement(itemId: number) {
  const changes = repo.listItemChanges(itemId);
  const latest = repo
    .listAnalyses(itemId, { limit: 1 })
    .find((a) => true); // listAnalyses는 analyzed_at DESC, id DESC — 첫 항목이 최신.
  const freshness = determineAnalysisFreshness(latest ?? null, changes, CURRENT_PROMPT_VERSION);

  const sqlSaysNeedsReanalysis = repo
    .listItems({ needsAnalysis: true, promptVersion: CURRENT_PROMPT_VERSION, pageSize: 1000 })
    .items.some((i) => i.id === itemId);

  if (latest === undefined) {
    // 분석 자체가 없으면 SQL의 needsAnalysis 필터는 이 물건을 절대 포함하지 않는다
    // (finding 2 — ANALYZED_EXISTS). 화면은 pending.
    expect(freshness).toBe("pending");
    expect(sqlSaysNeedsReanalysis).toBe(false);
    return;
  }

  // 분석이 있는 물건: SQL이 재분석 대상이라고 하면 화면은 반드시 stale, 아니면 fresh.
  expect(freshness).toBe(sqlSaysNeedsReanalysis ? "stale" : "fresh");
}

describe("determineAnalysisFreshness ↔ NEEDS_ANALYSIS_PREDICATE 실제 저장소 일치성", () => {
  it("분석이 아예 없는 물건 — 둘 다 '대상 아님/대기 중'", () => {
    repo.upsertItems([makeItem()], { now: "2026-01-01T00:00:00.000Z" });
    const item = repo.listItems({ pageSize: 10 }).items[0]!;
    assertAgreement(item.id);
  });

  it("분석 후 변경 없음, 버전도 같음 — 둘 다 최신", () => {
    repo.upsertItems([makeItem()], { now: "2026-01-01T00:00:00.000Z" });
    const item = repo.listItems({ pageSize: 10 }).items[0]!;
    repo.insertAnalysis(
      { itemId: item.id, body: "x", model: null, promptVersion: CURRENT_PROMPT_VERSION },
      { now: "2026-01-02T00:00:00.000Z" },
    );
    assertAgreement(item.id);
  });

  it("분석 후 실제 변경(kind=change) — 둘 다 갱신 예정/재분석 대상", () => {
    repo.upsertItems([makeItem()], { now: "2026-01-01T00:00:00.000Z" });
    const item = repo.listItems({ pageSize: 10 }).items[0]!;
    repo.insertAnalysis(
      { itemId: item.id, body: "x", model: null, promptVersion: CURRENT_PROMPT_VERSION },
      { now: "2026-01-02T00:00:00.000Z" },
    );
    repo.upsertItems([makeItem({ minBidPrice: 1 })], { now: "2026-01-03T00:00:00.000Z" });
    assertAgreement(item.id);
  });

  it("분석 후 프롬프트 버전만 낡음(변경 없음) — 둘 다 갱신 예정/재분석 대상", () => {
    repo.upsertItems([makeItem()], { now: "2026-01-01T00:00:00.000Z" });
    const item = repo.listItems({ pageSize: 10 }).items[0]!;
    repo.insertAnalysis(
      { itemId: item.id, body: "x", model: null, promptVersion: "v0" },
      { now: "2026-01-02T00:00:00.000Z" },
    );
    assertAgreement(item.id);
  });

  it("기준점(baseline)만 최신 분석 이후에 있음 — 둘 다 '변경 아님'으로 최신 유지", () => {
    // 1차 수집(기준점) → 분석 → 2차 수집이 같은 값이면 upsert가 기준점을 새로 만들지
    // 않는다. 대신 최초 수집 자체가 분석보다 뒤에 있는 케이스로 "기준점만 분석 이후"를
    // 재현한다: 물건은 분석 시각 이후 최초로 나타나지만, 그 첫 행은 kind=baseline이다.
    repo.upsertItems([makeItem({ itemNo: "later" })], { now: "2026-01-05T00:00:00.000Z" });
    const item = repo.listItems({ pageSize: 10 }).items.find((i) => i.itemNo === "later")!;
    // 분석 시각을 기준점보다 나중으로 만들 수는 없으므로(분석은 물건이 존재해야 가능),
    // 대신 실제 변경이 전혀 없는 물건(기준점 하나뿐)에서 분석이 그 뒤에 온 표준 케이스로
    // 일치성을 확인한다 — repository.test.ts의 "기준점 행은 재분석 대상으로 만들지 않는다"와
    // 동일 시나리오.
    repo.insertAnalysis(
      { itemId: item.id, body: "x", model: null, promptVersion: CURRENT_PROMPT_VERSION },
      { now: "2026-01-06T00:00:00.000Z" },
    );
    assertAgreement(item.id);
  });

  it("변경이 분석보다 앞섬(경계 이전) — 이미 반영된 것으로 보고 둘 다 최신", () => {
    repo.upsertItems([makeItem()], { now: "2026-01-01T00:00:00.000Z" }); // 기준점
    repo.upsertItems([makeItem({ minBidPrice: 1 })], { now: "2026-01-02T00:00:00.000Z" }); // 실제 변경
    const item = repo.listItems({ pageSize: 10 }).items[0]!;
    repo.insertAnalysis(
      { itemId: item.id, body: "x", model: null, promptVersion: CURRENT_PROMPT_VERSION },
      { now: "2026-01-03T00:00:00.000Z" }, // 변경보다 나중 — 이미 반영됨
    );
    assertAgreement(item.id);
  });

  it("변경과 프롬프트 버전 불일치가 동시에 있어도 둘 다 하나의 결론(대상/stale)으로 수렴", () => {
    repo.upsertItems([makeItem()], { now: "2026-01-01T00:00:00.000Z" });
    const item = repo.listItems({ pageSize: 10 }).items[0]!;
    repo.insertAnalysis(
      { itemId: item.id, body: "x", model: null, promptVersion: "v0" },
      { now: "2026-01-02T00:00:00.000Z" },
    );
    repo.upsertItems([makeItem({ minBidPrice: 1 })], { now: "2026-01-03T00:00:00.000Z" });
    assertAgreement(item.id);
  });

  it("여러 물건이 섞인 저장소에서도 개별 물건 단위로 전부 일치한다", () => {
    repo.upsertItems(
      [
        makeItem({ itemNo: "unanalyzed" }),
        makeItem({ itemNo: "fresh" }),
        makeItem({ itemNo: "stale-changed" }),
        makeItem({ itemNo: "stale-version" }),
      ],
      { now: "2026-01-01T00:00:00.000Z" },
    );
    const items = repo.listItems({ pageSize: 10 }).items;
    const idOf = (no: string) => items.find((i) => i.itemNo === no)!.id;

    repo.insertAnalysis(
      { itemId: idOf("fresh"), body: "x", model: null, promptVersion: CURRENT_PROMPT_VERSION },
      { now: "2026-01-02T00:00:00.000Z" },
    );
    repo.insertAnalysis(
      { itemId: idOf("stale-changed"), body: "x", model: null, promptVersion: CURRENT_PROMPT_VERSION },
      { now: "2026-01-02T00:00:00.000Z" },
    );
    repo.upsertItems([makeItem({ itemNo: "stale-changed", minBidPrice: 1 })], {
      now: "2026-01-03T00:00:00.000Z",
    });
    repo.insertAnalysis(
      { itemId: idOf("stale-version"), body: "x", model: null, promptVersion: "v0" },
      { now: "2026-01-02T00:00:00.000Z" },
    );

    for (const no of ["unanalyzed", "fresh", "stale-changed", "stale-version"]) {
      assertAgreement(idOf(no));
    }
  });
});

describe("쿨다운 중에도 화면은 경고를 유지한다 — 의도된 SQL/화면 불일치", () => {
  it("쿨다운 중에는 SQL 재분석 후보에서 빠지지만, 화면은 여전히 갱신 예정(stale)이다", () => {
    repo.upsertItems([makeItem()], { now: "2026-01-01T00:00:00.000Z" });
    const item = repo.listItems({ pageSize: 10 }).items[0]!;
    repo.insertAnalysis(
      { itemId: item.id, body: "x", model: null, promptVersion: CURRENT_PROMPT_VERSION },
      { now: "2026-01-02T00:00:00.000Z" },
    );
    // 분석 3시간 뒤 실제 변경.
    repo.upsertItems([makeItem({ minBidPrice: 1 })], { now: "2026-01-02T03:00:00.000Z" });

    // "지금"을 분석 12시간 후로 고정 — 24시간 쿨다운 안.
    const sqlResult = repo.listItems(
      {
        needsAnalysis: true,
        promptVersion: CURRENT_PROMPT_VERSION,
        reanalysisCooldownHours: 24,
        pageSize: 10,
      },
      { now: "2026-01-02T12:00:00.000Z" },
    );
    expect(sqlResult.items.map((i) => i.id)).not.toContain(item.id); // 워커: 이번 회차엔 안 집는다

    const changes = repo.listItemChanges(item.id);
    const latest = repo.listAnalyses(item.id, { limit: 1 })[0]!;
    const freshness = determineAnalysisFreshness(latest, changes, CURRENT_PROMPT_VERSION);
    expect(freshness).toBe("stale"); // 화면: 옛 값 기준 분석이라는 경고는 유지한다

    // isRealChange로도 실제 변경이 있었음을 다시 확인 — 화면의 stale 판정 근거.
    expect(changes.some(isRealChange)).toBe(true);
  });
});
