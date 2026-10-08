import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startCollector } from "../../../workers/collector";
import { closeDb, getCollectorState, getDb } from "../../../src/lib/db";
import { COLLECTOR_CONTRACTS_DIR, generateStoreGoldens, type StoreGolden, type StoreGoldenStep } from "../generate-store-goldens";
import { STORE_SCENARIOS, at } from "../store-scenarios";

type Row = Record<string, unknown>;

let goldens: Map<string, StoreGolden>;
let files: Map<string, string>;

beforeAll(async () => {
  const result = await generateStoreGoldens();
  goldens = result.goldens;
  files = result.files;
}, 120_000);

const steps = (name: string): StoreGoldenStep[] => goldens.get(name)!.steps;
const lastRun = (s: StoreGoldenStep): Row => s.snapshot.workerRuns[s.snapshot.workerRuns.length - 1]!;
const detail = (s: StoreGoldenStep): Row => lastRun(s).detail as Row;
const state = (s: StoreGoldenStep, key: string): unknown => s.snapshot.collectorState.find((r) => r.key === key)?.value ?? null;
const ROTATION = "collector.rotation.nextCourtCode";

describe("저장 골든 생성 (1.5)", () => {
  it("시나리오 10개를 정의한다", () => {
    expect(STORE_SCENARIOS.map((s) => s.name)).toEqual([
      "collect-insert-baseline",
      "collect-update-change",
      "collect-duplicate-in-batch",
      "collect-rotation-budget",
      "collect-court-removed",
      "collect-blocked",
      "collect-failed",
      "photos-outcomes",
      "photos-blocked-and-retry",
      "shared-backoff",
    ]);
    expect(goldens.size).toBe(10);
  });

  it("결정적이고, 커밋된 골든과 바이트까지 같다", async () => {
    const second = await generateStoreGoldens();
    expect([...second.files]).toEqual([...files]);

    const committed = readdirSync(COLLECTOR_CONTRACTS_DIR).filter((f) => f.endsWith(".json")).sort();
    expect(committed).toEqual([...files.keys()].sort());
    for (const [name, text] of files) {
      expect(text, name).toBe(readFileSync(path.join(COLLECTOR_CONTRACTS_DIR, name), "utf8"));
    }
  }, 120_000);

  it("collect-insert-baseline: 신규 3건, 값 없는 필드는 기준점이 없다", () => {
    const [s] = steps("collect-insert-baseline");
    expect(detail(s!)).toMatchObject({ inserted: 3, updated: 0, changed: 0, itemsFetched: 3, pagesRequested: 3 });
    expect(s!.snapshot.items).toHaveLength(3);
    const changes = s!.snapshot.itemChanges;
    expect(changes.every((c) => c.kind === "baseline" && c.old_value === null)).toBe(true);
    expect(changes).toHaveLength(4 + 4 + 3);
    const third = s!.snapshot.items.find((i) => i.case_no === "2026타경1003")!;
    expect(changes.filter((c) => c.item_id === third.id).map((c) => c.field)).toEqual(["minBidPrice", "failedBidCount", "status"]);
  });

  it("collect-update-change: 신규 1·갱신 4·변경 2, 감시 필드만 이력, first_seen_at 보존", () => {
    const [first, second] = steps("collect-update-change");
    expect(detail(second!)).toMatchObject({ inserted: 1, updated: 4, changed: 2 });
    const changeRows = second!.snapshot.itemChanges.filter((c) => c.kind === "change");
    expect(changeRows.map((c) => `${c.field}:${c.old_value}->${c.new_value}`).sort()).toEqual(
      [
        "minBidPrice:240000000->192000000",
        "failedBidCount:0->1",
        "status:신건->유찰 1회",
        "auctionDate:null->2026-12-01",
      ].sort(),
    );
    // 소재지만 바뀐 물건(2002)은 갱신되지만 이력이 없다
    const b = second!.snapshot.items.find((i) => i.case_no === "2026타경2002")!;
    expect(String(b.address)).toContain("이전한 주소");
    expect(second!.snapshot.itemChanges.filter((c) => c.item_id === b.id && c.kind === "change")).toHaveLength(0);
    const a1 = first!.snapshot.items.find((i) => i.case_no === "2026타경2001")!;
    const a2 = second!.snapshot.items.find((i) => i.case_no === "2026타경2001")!;
    expect(a2.first_seen_at).toBe(a1.first_seen_at);
    expect(a2.last_seen_at).toBe(at(10));
  });

  it("collect-duplicate-in-batch: TS의 이력 행과 changed 집계 그대로", () => {
    const [, dup, flip] = steps("collect-duplicate-in-batch");
    expect(detail(dup!)).toMatchObject({ inserted: 2, updated: 4, changed: 1, itemsFetched: 6 });
    // 물건 id가 1, 4, 6인 것은 갱신(ON CONFLICT)도 AUTOINCREMENT를 한 칸씩 쓰기 때문이다(X 갱신 2회 -> id 2,3 소모).
    const rows = dup!.snapshot.itemChanges.slice(4).map((c) => `${c.item_id}:${c.field}:${c.old_value}->${c.new_value}:${c.kind}`);
    expect(rows).toEqual([
      "1:minBidPrice:1000->900:change",
      "1:failedBidCount:0->1:change",
      "1:minBidPrice:900->800:change",
      "4:minBidPrice:null->500:baseline",
      "4:failedBidCount:null->0:baseline",
      "4:auctionDate:null->2026-11-05:baseline",
      "4:status:null->신건:baseline",
      "4:minBidPrice:500->400:change",
      "6:minBidPrice:null->7:change",
    ]);
    // 배치 안에서 값이 바뀌었다가 시작값으로 돌아오면 changed에 세지 않는다
    expect(detail(flip!)).toMatchObject({ inserted: 0, updated: 2, changed: 0 });
  });

  it("collect-rotation-budget: 상한에서 다음 법원 미시작, 다음 회차는 거기서 이어서", () => {
    const s = steps("collect-rotation-budget");
    expect((detail(s[0]!).targetCourts as string[]).length).toBe(1);
    expect(detail(s[0]!)).toMatchObject({ pagesRequested: 3 });
    expect((detail(s[1]!).targetCourts as string[]).length).toBe(2);
    expect(s.map((x) => state(x, ROTATION))).toEqual([
      "B000211",
      "B000210",
      "B000211",
      "B000212",
      "B000210",
      "B000211",
    ]);
    expect(s[1]!.calls.map((c) => c.courtCode)).toEqual(["B000211", "B000212"]);
  });

  it("collect-court-removed: 저장된 법원이 목록에 없으면 처음부터", () => {
    const s = steps("collect-court-removed");
    expect(s.map((x) => state(x, ROTATION))).toEqual(["B000211", "B000212", "B000211"]);
    expect(s[2]!.calls.map((c) => c.courtCode)).toEqual(["B000210"]);
  });

  it("collect-blocked: 물건 미저장, blocked, 위치 유지, 백오프 1시간, 건너뜀, 더 이른 연장 무시, 백오프 뒤 정상", () => {
    const [blocked, skipped, ignored, resumed] = steps("collect-blocked");
    expect(lastRun(blocked!)).toMatchObject({ outcome: "blocked", error_kind: "RobotDetectedError" });
    expect(detail(blocked!)).toMatchObject({ pagesRequested: 3, itemsFetched: 2, inserted: 0 });
    expect(blocked!.snapshot.items).toHaveLength(0);
    expect(state(blocked!, ROTATION)).toBe("B000211");
    expect(state(blocked!, "backoff_until")).toBe(at(60));

    expect(lastRun(skipped!)).toMatchObject({ outcome: "skipped", error_kind: "backoff", started_at: at(10), finished_at: at(10) });
    expect(skipped!.calls).toEqual([]);

    expect(state(ignored!, "backoff_until")).toBe(at(60));

    expect(lastRun(resumed!)).toMatchObject({ outcome: "success" });
    expect(resumed!.snapshot.items).toHaveLength(3);
    expect(resumed!.calls.map((c) => c.courtCode)).toEqual(["B000211", "B000210"]);
  });

  it("collect-failed: failed·백오프 없음·실패한 법원이 다음 시작 위치·요청 수 기록", () => {
    const s = steps("collect-failed");
    expect(s.map((x) => lastRun(x).outcome)).toEqual(["failed", "failed", "success", "success"]);
    expect(s.map((x) => lastRun(x).error_kind)).toEqual(["ResponseSchemaError", "SourceRequestError", null, null]);
    expect(s.map((x) => detail(x).pagesRequested)).toEqual([1, 0, 1, 1]);
    expect(s.map((x) => state(x, ROTATION))).toEqual(["B000210", "B000210", "B000211", "B000210"]);
    expect(s.every((x) => state(x, "backoff_until") === null)).toBe(true);
  });

  it("photos-outcomes: 성공·사진 없음·실패 집계, 전부 실패는 failed, 대기 없음은 성공 0건", () => {
    const s = steps("photos-outcomes");
    expect(s[1]!.tickResult).toBe("success");
    expect(detail(s[1]!)).toEqual({ attempted: 4, collected: 1, empty: 1, failed: 2, requestsMade: 5 });
    expect(s[1]!.snapshot.photoFiles.map((f) => f.path)).toEqual(["5/1.gif", "5/2.png"]);
    expect(s[1]!.sleeps).toEqual([30000, 30000, 30000, 30000]);
    expect(detail(s[2]!)).toMatchObject({ attempted: 0, requestsMade: 0 });
    expect(s[4]!.tickResult).toBe("failed");
    expect(lastRun(s[4]!)).toMatchObject({ outcome: "failed", error_kind: "SourceRequestError" });
    expect(detail(s[6]!)).toMatchObject({ attempted: 0 });
    expect(s[6]!.calls).toEqual([]);
  });

  it("photos-blocked-and-retry: 차단된 물건은 실패로 안 적고, 실패는 1시간 뒤 제외·25시간 뒤 포함", () => {
    const s = steps("photos-blocked-and-retry");
    expect(s[1]!.tickResult).toBe("blocked");
    expect(detail(s[1]!)).toMatchObject({ attempted: 2, collected: 1, failed: 0 });
    const blockedItem = s[1]!.snapshot.items.find((i) => i.case_no === "2026타경9002")!;
    expect(blockedItem.photo_status).toBeNull();
    expect(state(s[1]!, "backoff_until")).toBe(at(65));
    expect(s[2]!.tickResult).toBe("skipped");
    expect(detail(s[3]!)).toMatchObject({ attempted: 2, collected: 1, failed: 1 });
    expect(s[3]!.snapshot.items.find((i) => i.case_no === "2026타경9002")!.photo_status).toBe("failed");
    expect(s[4]!.calls).toEqual([]); // 방금 실패한 물건은 제외
    expect(s[6]!.calls.map((c) => c.internalCaseNo)).toEqual(["20260130009004", "20260130009002"]); // 미시도 먼저
  });

  it("shared-backoff: 사진 차단은 수집을, 수집 차단은 사진을 건너뛰게 한다", () => {
    const s = steps("shared-backoff");
    expect(lastRun(s[1]!)).toMatchObject({ worker: "photos", outcome: "blocked" });
    expect(lastRun(s[2]!)).toMatchObject({ worker: "collector", outcome: "skipped", error_kind: "backoff" });
    expect(s[2]!.calls).toEqual([]);
    expect(lastRun(s[3]!)).toMatchObject({ worker: "collector", outcome: "blocked" });
    expect(s[4]!.tickResult).toBe("skipped");
    expect(lastRun(s[4]!)).toMatchObject({ worker: "photos", outcome: "skipped", error_kind: "backoff" });
    expect(lastRun(s[6]!)).toMatchObject({ worker: "photos", outcome: "success" });
    expect(s[6]!.snapshot.itemPhotos).toHaveLength(2);
  });
});

describe("TS 동작 고정: 저장이 실패한 회차의 로테이션 위치 (design.md D8)", () => {
  const savedDb = process.env.AUCTIONBOSS_DB;
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "auctionboss-save-fail-"));
    process.env.AUCTIONBOSS_DB = path.join(dir, "auctionboss.db");
  });
  afterAll(() => {
    closeDb();
    if (savedDb === undefined) delete process.env.AUCTIONBOSS_DB;
    else process.env.AUCTIONBOSS_DB = savedDb;
    rmSync(dir, { recursive: true, force: true });
  });

  it("이력 INSERT가 실패하면 회차는 failed·물건은 하나도 안 남고, 위치는 이번 회차 대상의 다음 법원으로 전진한다", async () => {
    const db = getDb();
    db.exec("CREATE TRIGGER fail_history BEFORE INSERT ON item_changes BEGIN SELECT RAISE(ABORT, 'history failure'); END;");
    const courts = [
      { name: "A", courtCode: "CA" },
      { name: "B", courtCode: "CB" },
      { name: "C", courtCode: "CC" },
    ];
    const item = {
      court: "A", caseNo: "1", itemNo: "1", address: null, usageType: null, appraisalPrice: null,
      minBidPrice: 100, auctionDate: null, failedBidCount: 0, status: null,
    };
    const handle = startCollector({
      source: {
        fetchActiveItems: async () => ({ items: [item], pagesRequested: 1 }),
        fetchItemPhotos: async () => ({ photos: [], requestsMade: 0 }),
      },
      scope: { courts, maxCourtsPerRun: 2, maxRequestsPerRun: 13 },
      intervalMs: 3_600_000,
      logger: { info() {}, warn() {}, error() {} },
      runImmediately: false,
    });
    await handle.tick();
    await handle.stop();

    expect((db.prepare("SELECT COUNT(*) AS c FROM items").get() as { c: number }).c).toBe(0);
    const run = db.prepare("SELECT outcome, error_kind FROM worker_runs").get() as { outcome: string; error_kind: string };
    expect(run.outcome).toBe("failed");
    expect(getCollectorState(ROTATION)).toBe("CC");
    expect(getCollectorState("backoff_until")).toBeNull();
  });
});
