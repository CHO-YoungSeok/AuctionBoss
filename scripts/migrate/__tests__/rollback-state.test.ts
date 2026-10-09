import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { closeDb, openDatabase, type Db } from "../../../src/lib/db";
import { COLLECTOR_STATE_KEYS, createCollectorStateRepository } from "../../../src/lib/db/collector-state";
import { startCollector } from "../../../workers/collector";
import type { AuctionSource } from "../../../src/lib/sources";
import {
  applyRollbackState,
  formatResult,
  parseExportedState,
  rollbackState,
  RollbackStateError,
  type ExportedState,
} from "../rollback-state";

let work: string;
let dbPath: string;
let db: Db;

beforeEach(() => {
  work = mkdtempSync(path.join(tmpdir(), "rollback-state-"));
  dbPath = path.join(work, "rollback-target.db");
  db = openDatabase(dbPath);
});
afterEach(() => {
  if (db.open) db.close();
  closeDb();
  delete process.env.AUCTIONBOSS_DB;
  rmSync(work, { recursive: true, force: true });
});

const repo = () => createCollectorStateRepository(db);
const iso = (ms: number) => new Date(ms).toISOString();
const state = (s: Partial<ExportedState>): ExportedState => ({ backoffUntil: null, rotationNextCourtCode: null, ...s });
const future = (hours: number) => Date.now() + hours * 3_600_000;

describe("applyRollbackState", () => {
  it("MySQL 백오프가 SQLite 값보다 늦으면 쓴다", () => {
    repo().extendBackoffUntil(new Date(future(1)));
    const later = iso(future(5));
    expect(applyRollbackState(db, state({ backoffUntil: later })).backoff).toBe("written");
    expect(repo().getBackoffUntil()?.toISOString()).toBe(later);
  });

  it("SQLite에 백오프가 없으면 MySQL 값을 쓴다", () => {
    const v = iso(future(2));
    expect(applyRollbackState(db, state({ backoffUntil: v })).backoff).toBe("written");
    expect(repo().getBackoffUntil()?.toISOString()).toBe(v);
  });

  it("MySQL 백오프가 더 이르면 SQLite 값을 유지한다(짧아지지 않음)", () => {
    const keep = iso(future(10));
    repo().extendBackoffUntil(new Date(keep));
    expect(applyRollbackState(db, state({ backoffUntil: iso(future(1)) })).backoff).toBe("kept");
    expect(repo().getBackoffUntil()?.toISOString()).toBe(keep);
    // 같은 시각도 유지
    expect(applyRollbackState(db, state({ backoffUntil: keep })).backoff).toBe("kept");
  });

  it("MySQL에 백오프가 없으면(null) SQLite를 건드리지 않는다", () => {
    const keep = iso(future(3));
    repo().extendBackoffUntil(new Date(keep));
    expect(applyRollbackState(db, state({})).backoff).toBe("absent");
    expect(repo().getBackoffUntil()?.toISOString()).toBe(keep);
    const empty = openDatabase(path.join(work, "empty.db"));
    expect(applyRollbackState(empty, state({})).backoff).toBe("absent");
    expect(createCollectorStateRepository(empty).getBackoffUntil()).toBeNull();
    empty.close();
  });

  it("로테이션 위치는 항상 덮어쓴다(MySQL 값이 없으면 그대로)", () => {
    repo().setCollectorState(COLLECTOR_STATE_KEYS.ROTATION_NEXT_COURT_CODE, "OLD");
    expect(applyRollbackState(db, state({ rotationNextCourtCode: "NEW" })).rotation).toBe("written");
    expect(repo().getCollectorState(COLLECTOR_STATE_KEYS.ROTATION_NEXT_COURT_CODE)).toBe("NEW");
    expect(applyRollbackState(db, state({})).rotation).toBe("absent");
    expect(repo().getCollectorState(COLLECTOR_STATE_KEYS.ROTATION_NEXT_COURT_CODE)).toBe("NEW");
  });

  it("쓴 뒤 TS 수집기의 백오프 판정이 건너뜀을 돌려준다(실제 수집기 tick, 외부 요청 없음)", async () => {
    applyRollbackState(db, state({ backoffUntil: iso(future(4)) }));
    db.close();
    process.env.AUCTIONBOSS_DB = dbPath;
    let sourceCalls = 0;
    const source: AuctionSource = {
      fetchItemPhotos: async () => ({ photos: [], requestsMade: 0 }),
      fetchActiveItems: async () => {
        sourceCalls += 1;
        return { items: [], pagesRequested: 0 };
      },
    };
    const silent = { info() {}, warn() {}, error() {} };
    const handle = startCollector({
      source,
      scope: { courts: [{ name: "합성법원", courtCode: "B000001" }], maxCourtsPerRun: 1, maxRequestsPerRun: 9 },
      intervalMs: 999_000_000,
      runImmediately: false,
      logger: silent,
    });
    await handle.tick();
    await handle.stop();
    expect(sourceCalls).toBe(0);
    const check = openDatabase(dbPath);
    const row = check.prepare("SELECT outcome, error_kind FROM worker_runs WHERE worker = 'collector'").get() as { outcome: string; error_kind: string };
    check.close();
    expect(row.outcome).toBe("skipped");
    expect(row.error_kind).toBe("backoff");
  });

  it("되쓰기 없이는(대조) 같은 수집기가 소스를 부른다 — 위 테스트가 헛돌지 않음을 확인", async () => {
    db.close();
    process.env.AUCTIONBOSS_DB = dbPath;
    let sourceCalls = 0;
    const source: AuctionSource = {
      fetchItemPhotos: async () => ({ photos: [], requestsMade: 0 }),
      fetchActiveItems: async () => {
        sourceCalls += 1;
        return { items: [], pagesRequested: 0 };
      },
    };
    const silent = { info() {}, warn() {}, error() {} };
    const handle = startCollector({
      source,
      scope: { courts: [{ name: "합성법원", courtCode: "B000001" }], maxCourtsPerRun: 1, maxRequestsPerRun: 9 },
      intervalMs: 999_000_000,
      runImmediately: false,
      logger: silent,
    });
    await handle.tick();
    await handle.stop();
    expect(sourceCalls).toBe(1);
  });
});

describe("parseExportedState·rollbackState", () => {
  it("export-state 출력(로그 줄이 섞여도 JSON 줄)을 읽는다", () => {
    const text = `[export-state] start\n{"backoffUntil":"2026-10-09T01:02:03.000Z","rotationNextCourtCode":null}\n`;
    expect(parseExportedState(text)).toEqual({ backoffUntil: "2026-10-09T01:02:03.000Z", rotationNextCourtCode: null });
  });

  it("형식이 다르면 입력 값 없이 실패한다", () => {
    const SENTINEL = "__REAL_NAME_SENTINEL__";
    for (const bad of ["", "no json", `{"backoffUntil":"${SENTINEL}","rotationNextCourtCode":null}`, `{"backoffUntil":null}`, `{"backoffUntil":null,"rotationNextCourtCode":"","x":"${SENTINEL}"}`, `{"backoffUntil":null,"rotationNextCourtCode":"${SENTINEL}",}`]) {
      let message = "";
      try {
        parseExportedState(bad);
      } catch (e) {
        expect(e).toBeInstanceOf(RollbackStateError);
        message = (e as Error).message;
      }
      expect(message).not.toBe("");
      expect(message).not.toContain(SENTINEL);
    }
  });

  it("대상 경로가 없으면 새 DB를 만들지 않고 실패한다", () => {
    const missing = path.join(work, "nope", "x.db");
    expect(() => rollbackState(missing, '{"backoffUntil":null,"rotationNextCourtCode":null}')).toThrow(RollbackStateError);
    expect(existsSync(missing)).toBe(false);
    expect(() => rollbackState("", "{}")).toThrow(/--sqlite/);
  });

  it("파일에서 되쓰고 결과 문구를 만든다", () => {
    db.close();
    const f = path.join(work, "state.json");
    writeFileSync(f, `{"backoffUntil":"${iso(future(2))}","rotationNextCourtCode":"B000999"}\n`);
    const r = rollbackState(dbPath, readFileSync(f, "utf8"));
    expect(r).toEqual({ backoff: "written", rotation: "written" });
    expect(formatResult(r)).toContain("백오프: 기록");
  });
});
