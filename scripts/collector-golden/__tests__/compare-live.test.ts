import { describe, expect, it } from "vitest";

import { COMPARED_COLUMNS, compareItems, evaluatePreflight, printSql } from "../compare-live";

const base = { court: "C", case_no: "2026타경1", item_no: "1", address: "A", min_bid_price: 100, auction_date: "2026-11-01" };
const NOW = new Date("2026-10-09T12:00:00.000Z");

describe("compareItems", () => {
  it("같은 값이면 불일치 0, 같은 물건으로 센다", () => {
    const r = compareItems([base], [{ ...base }]);
    expect(r).toMatchObject({ matched: 1, onlyInSpring: 0, mismatchedItems: 0, mismatchedCells: 0, duplicateKeysInSpring: 0 });
  });

  it("값이 다르면 그 컬럼만 센다", () => {
    const r = compareItems([base], [{ ...base, address: "B", min_bid_price: 101 }]);
    expect(r.mismatchedItems).toBe(1);
    expect(r.mismatchedCells).toBe(2);
    expect(r.byColumn).toEqual({ address: 1, min_bid_price: 1 });
  });

  it("null과 값, null과 빈 문자열은 다르다", () => {
    expect(compareItems([{ ...base, address: null }], [base]).byColumn).toEqual({ address: 1 });
    expect(compareItems([{ ...base, address: "" }], [{ ...base, address: null }]).byColumn).toEqual({ address: 1 });
    // 없는 키(undefined)는 null과 같다
    expect(compareItems([{ ...base, address: null }], [{ ...base, address: undefined }]).mismatchedItems).toBe(0);
  });

  it("숫자와 숫자꼴 문자열은 같게 본다", () => {
    expect(compareItems([{ ...base, min_bid_price: 100 }], [{ ...base, min_bid_price: "100" }]).mismatchedItems).toBe(0);
  });

  it("시각·id·사진 상태 컬럼은 비교하지 않는다", () => {
    const r = compareItems(
      [{ ...base, id: 1, first_seen_at: "x", last_seen_at: "x", photo_status: "collected" }],
      [{ ...base, id: 9, first_seen_at: "y", last_seen_at: "y", photo_status: null }],
    );
    expect(r.mismatchedItems).toBe(0);
    for (const c of ["id", "first_seen_at", "last_seen_at", "photo_status", "photo_count", "photo_collected_at", "photo_attempted_at"]) {
      expect(COMPARED_COLUMNS as readonly string[]).not.toContain(c);
    }
  });

  it("TS SQLite에 없는 물건은 따로 세고 불일치로 보지 않는다", () => {
    const r = compareItems([base, { ...base, item_no: "2" }], [base]);
    expect(r).toMatchObject({ matched: 1, onlyInSpring: 1, mismatchedItems: 0 });
  });

  it("확인용 DB의 자연 키 중복을 센다", () => {
    expect(compareItems([base, { ...base }], [base]).duplicateKeysInSpring).toBe(1);
  });

  it("자연 키가 다르면 다른 물건이다(법원·사건번호·물건번호 모두)", () => {
    for (const k of ["court", "case_no", "item_no"] as const) {
      expect(compareItems([{ ...base, [k]: "다름" }], [base])).toMatchObject({ matched: 0, onlyInSpring: 1 });
    }
  });
});

describe("printSql", () => {
  it("자연 키와 비교 컬럼을 모두 뽑는 SELECT 하나다", () => {
    const sql = printSql();
    expect(sql.startsWith("SELECT JSON_OBJECT(")).toBe(true);
    for (const c of [...COMPARED_COLUMNS, "court", "case_no", "item_no"]) expect(sql).toContain(`'${c}', ${c}`);
    expect(sql).not.toContain(";");
  });
});

describe("evaluatePreflight", () => {
  const ago = (min: number) => new Date(NOW.getTime() - min * 60000).toISOString();
  const run = (min: number, over: object = {}) => ({ worker: "collector", outcome: "success", startedAt: ago(min + 1), finishedAt: ago(min), ...over });

  it("백오프 없음, 회차 없음이면 통과", () => {
    expect(evaluatePreflight({ now: NOW, gapMinutes: 15, backoffUntil: null, runs: [] }).ok).toBe(true);
  });

  it("남은 백오프는 실패, 만료된 백오프는 통과", () => {
    const future = new Date(NOW.getTime() + 10 * 60000).toISOString();
    expect(evaluatePreflight({ now: NOW, gapMinutes: 15, backoffUntil: future, runs: [] }).ok).toBe(false);
    expect(evaluatePreflight({ now: NOW, gapMinutes: 15, backoffUntil: ago(1), runs: [] }).ok).toBe(true);
    expect(evaluatePreflight({ now: NOW, gapMinutes: 15, backoffUntil: "깨진 값", runs: [] }).ok).toBe(false);
  });

  it("직전 회차가 15분 안이면 실패, 15분 이상이면 통과(경계 포함)", () => {
    expect(evaluatePreflight({ now: NOW, gapMinutes: 15, backoffUntil: null, runs: [run(14)] }).ok).toBe(false);
    expect(evaluatePreflight({ now: NOW, gapMinutes: 15, backoffUntil: null, runs: [run(15)] }).ok).toBe(true);
    expect(evaluatePreflight({ now: NOW, gapMinutes: 15, backoffUntil: null, runs: [run(60), run(5, { worker: "photos" })] }).ok).toBe(false);
  });

  it("최근에 시작한 running 회차는 실패, 오래된 running 행은 알리기만 한다", () => {
    const fresh = { worker: "photos", outcome: "running", startedAt: ago(5), finishedAt: null };
    const stale = { worker: "photos", outcome: "running", startedAt: ago(600), finishedAt: null };
    expect(evaluatePreflight({ now: NOW, gapMinutes: 15, backoffUntil: null, runs: [fresh] }).ok).toBe(false);
    const r = evaluatePreflight({ now: NOW, gapMinutes: 15, backoffUntil: null, runs: [stale] });
    expect(r.ok).toBe(true);
    expect(r.lines.join("\n")).toContain("오래된 running");
  });
});
