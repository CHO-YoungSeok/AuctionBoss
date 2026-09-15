import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createCollectorStateRepository } from "../collector-state";
import { DEFAULT_DB_PATH, openDatabase, resolveDbPath } from "../client";
import { createRepository } from "../repository";

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(path.join(tmpdir(), "auctionboss-db-"));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe("openDatabase", () => {
  it("없는 디렉터리를 만들고 파일 DB에 WAL·foreign_keys를 켠다", () => {
    const dbPath = path.join(workDir, "nested", "auctionboss.db");
    const db = openDatabase(dbPath);
    try {
      expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
      expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    } finally {
      db.close();
    }
  });

  it("items·analyses 테이블과 인덱스를 만든다", () => {
    const db = openDatabase(path.join(workDir, "auctionboss.db"));
    try {
      const names = db
        .prepare<[], { name: string }>(
          "SELECT name FROM sqlite_master WHERE type IN ('table','index') ORDER BY name",
        )
        .all()
        .map((row) => row.name);

      expect(names).toContain("items");
      expect(names).toContain("analyses");
      expect(names).toContain("item_changes");
      expect(names).toContain("idx_items_auction_date");
      expect(names).toContain("idx_analyses_item_id");
      expect(names).toContain("idx_items_usage_type");
      expect(names).toContain("idx_items_min_bid_price");
      expect(names).toContain("idx_item_changes_item_id");
    } finally {
      db.close();
    }
  });

  it("worker_runs·인덱스를 만든다(add-collection-observability)", () => {
    const db = openDatabase(path.join(workDir, "auctionboss.db"));
    try {
      const names = db
        .prepare<[], { name: string }>(
          "SELECT name FROM sqlite_master WHERE type IN ('table','index') ORDER BY name",
        )
        .all()
        .map((row) => row.name);

      expect(names).toContain("worker_runs");
      expect(names).toContain("idx_worker_runs_worker_started_at");
    } finally {
      db.close();
    }
  });

  it("두 번 열어도 스키마 생성이 실패하지 않는다(IF NOT EXISTS)", () => {
    const dbPath = path.join(workDir, "auctionboss.db");
    const first = openDatabase(dbPath);
    first.close();
    const second = openDatabase(dbPath);
    second.close();
  });

  /**
   * 마이그레이션 경로 확인: 인덱스가 추가되기 **전** 스키마로 만들어진 기존 DB 파일을
   * 새 코드로 다시 열었을 때 오류 없이 인덱스만 추가되고 데이터가 보존돼야 한다.
   * 이 프로젝트는 마이그레이션 도구 없이 `CREATE ... IF NOT EXISTS`만 쓰므로
   * 이게 유일한 업그레이드 경로다.
   */
  it("인덱스 추가 전 스키마로 만든 기존 DB 파일에 새 스키마가 그대로 적용된다", () => {
    // 변경 이전(커밋 88a7aec) 스키마 그대로 — 용도·최저가 인덱스가 없다.
    const OLD_SCHEMA_SQL = `
      CREATE TABLE IF NOT EXISTS items (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        court             TEXT    NOT NULL,
        case_no           TEXT    NOT NULL,
        item_no           TEXT    NOT NULL,
        address           TEXT,
        usage_type        TEXT,
        appraisal_price   INTEGER,
        min_bid_price     INTEGER,
        auction_date      TEXT,
        failed_bid_count  INTEGER,
        status            TEXT,
        first_seen_at     TEXT    NOT NULL,
        last_seen_at      TEXT    NOT NULL,
        UNIQUE (court, case_no, item_no)
      );
      CREATE INDEX IF NOT EXISTS idx_items_auction_date ON items (auction_date);
      CREATE TABLE IF NOT EXISTS analyses (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        item_id        INTEGER NOT NULL REFERENCES items (id) ON DELETE CASCADE,
        body           TEXT    NOT NULL,
        model          TEXT,
        prompt_version TEXT    NOT NULL,
        analyzed_at    TEXT    NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_analyses_item_id ON analyses (item_id, analyzed_at DESC);
    `;

    const dbPath = path.join(workDir, "legacy.db");
    const legacy = new Database(dbPath);
    legacy.exec(OLD_SCHEMA_SQL);
    legacy
      .prepare(
        `INSERT INTO items (court, case_no, item_no, usage_type, min_bid_price,
                            first_seen_at, last_seen_at)
         VALUES ('서울중앙지방법원', '2025타경1', '1', '아파트', 400000000,
                 '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
      )
      .run();
    const legacyIndexes = legacy
      .prepare<[], { name: string }>("SELECT name FROM sqlite_master WHERE type = 'index'")
      .all()
      .map((row) => row.name);
    legacy.close();

    // 사전 조건: 옛 DB에는 새 인덱스가 없다.
    expect(legacyIndexes).not.toContain("idx_items_usage_type");
    expect(legacyIndexes).not.toContain("idx_items_min_bid_price");

    // 새 코드로 다시 열기 = 마이그레이션. 던지지 않아야 한다.
    const upgraded = openDatabase(dbPath);
    try {
      const names = upgraded
        .prepare<[], { name: string }>("SELECT name FROM sqlite_master WHERE type = 'index'")
        .all()
        .map((row) => row.name);
      expect(names).toContain("idx_items_usage_type");
      expect(names).toContain("idx_items_min_bid_price");

      // 기존 데이터가 그대로 남아 있고, 필터·정렬 쿼리가 새 인덱스로 정상 동작한다.
      const repo = createRepository(upgraded);
      const result = repo.listItems({
        usageTypes: ["아파트"],
        minPrice: 100_000_000,
        sort: "minBidPrice",
        direction: "desc",
      });
      expect(result.total).toBe(1);
      expect(result.items[0]?.caseNo).toBe("2025타경1");
      expect(repo.listUsageTypes()).toEqual(["아파트"]);
    } finally {
      upgraded.close();
    }
  });

  /**
   * 마이그레이션 경로 확인(2): `item_changes` 테이블이 추가되기 **직전** 스키마(용도·최저가
   * 인덱스는 이미 있는 상태, 즉 이 change 이전의 최신 스키마)로 만들어진 기존 DB 파일을
   * 새 코드로 다시 열었을 때 오류 없이 새 테이블·인덱스만 추가되고 데이터가 보존돼야 한다.
   */
  it("item_changes 테이블 추가 전 스키마로 만든 기존 DB 파일에 새 테이블이 그대로 적용된다", () => {
    const PRE_ITEM_CHANGES_SCHEMA_SQL = `
      CREATE TABLE IF NOT EXISTS items (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        court             TEXT    NOT NULL,
        case_no           TEXT    NOT NULL,
        item_no           TEXT    NOT NULL,
        address           TEXT,
        usage_type        TEXT,
        appraisal_price   INTEGER,
        min_bid_price     INTEGER,
        auction_date      TEXT,
        failed_bid_count  INTEGER,
        status            TEXT,
        first_seen_at     TEXT    NOT NULL,
        last_seen_at      TEXT    NOT NULL,
        UNIQUE (court, case_no, item_no)
      );
      CREATE INDEX IF NOT EXISTS idx_items_auction_date ON items (auction_date);
      CREATE INDEX IF NOT EXISTS idx_items_usage_type ON items (usage_type);
      CREATE INDEX IF NOT EXISTS idx_items_min_bid_price ON items (min_bid_price);
      CREATE TABLE IF NOT EXISTS analyses (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        item_id        INTEGER NOT NULL REFERENCES items (id) ON DELETE CASCADE,
        body           TEXT    NOT NULL,
        model          TEXT,
        prompt_version TEXT    NOT NULL,
        analyzed_at    TEXT    NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_analyses_item_id ON analyses (item_id, analyzed_at DESC);
    `;

    const dbPath = path.join(workDir, "pre-item-changes.db");
    const legacy = new Database(dbPath);
    legacy.exec(PRE_ITEM_CHANGES_SCHEMA_SQL);
    legacy
      .prepare(
        `INSERT INTO items (court, case_no, item_no, usage_type, min_bid_price,
                            first_seen_at, last_seen_at)
         VALUES ('서울중앙지방법원', '2025타경1', '1', '아파트', 400000000,
                 '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
      )
      .run();
    const legacyTables = legacy
      .prepare<[], { name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => row.name);
    legacy.close();

    // 사전 조건: 옛 DB에는 item_changes가 없다.
    expect(legacyTables).not.toContain("item_changes");

    // 새 코드로 다시 열기 = 마이그레이션. 던지지 않아야 한다.
    const upgraded = openDatabase(dbPath);
    try {
      const names = upgraded
        .prepare<[], { name: string }>(
          "SELECT name FROM sqlite_master WHERE type IN ('table', 'index')",
        )
        .all()
        .map((row) => row.name);
      expect(names).toContain("item_changes");
      expect(names).toContain("idx_item_changes_item_id");

      // 기존 물건 데이터가 그대로 남아 있다.
      const repo = createRepository(upgraded);
      const result = repo.listItems({ pageSize: 10 });
      expect(result.total).toBe(1);
      expect(result.items[0]?.caseNo).toBe("2025타경1");
      // 기존 DB의 물건이라 기준점 이력이 없다(design.md 리스크: 소급 불가) — 빈 배열이다.
      expect(repo.listItemChanges(result.items[0]!.id)).toEqual([]);
    } finally {
      upgraded.close();
    }
  });

  /**
   * 마이그레이션 경로 확인(3, 코드 리뷰 finding 1): `item_changes.kind` 컬럼이 추가되기
   * **직전** 스키마(이 코드 리뷰 이전, 커밋 6be2084에 실제로 배포됐던 스키마 — 테이블은
   * 있지만 `kind` 컬럼이 없다)로 만든 DB 파일을 새 코드로 열었을 때, 오류 없이 컬럼이
   * 추가되고 기존 행이 `old_value IS NULL` 규칙 그대로 백필되는지 확인한다.
   *
   * `CREATE TABLE IF NOT EXISTS`는 이미 있는 테이블에 컬럼을 추가해 주지 않으므로, 이
   * 케이스는 위 두 마이그레이션 테스트와 달리 `ALTER TABLE`이 실제로 실행되는 유일한
   * 경로다 — client.ts의 `migrateItemChangesKindColumn`을 직접 검증한다.
   */
  it("item_changes.kind 컬럼 추가 전 스키마로 만든 기존 DB 파일에 컬럼이 추가되고 기존 행이 백필된다", () => {
    const PRE_KIND_COLUMN_SCHEMA_SQL = `
      CREATE TABLE IF NOT EXISTS items (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        court             TEXT    NOT NULL,
        case_no           TEXT    NOT NULL,
        item_no           TEXT    NOT NULL,
        address           TEXT,
        usage_type        TEXT,
        appraisal_price   INTEGER,
        min_bid_price     INTEGER,
        auction_date      TEXT,
        failed_bid_count  INTEGER,
        status            TEXT,
        first_seen_at     TEXT    NOT NULL,
        last_seen_at      TEXT    NOT NULL,
        UNIQUE (court, case_no, item_no)
      );
      CREATE TABLE IF NOT EXISTS analyses (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        item_id        INTEGER NOT NULL REFERENCES items (id) ON DELETE CASCADE,
        body           TEXT    NOT NULL,
        model          TEXT,
        prompt_version TEXT    NOT NULL,
        analyzed_at    TEXT    NOT NULL
      );
      CREATE TABLE IF NOT EXISTS item_changes (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        item_id    INTEGER NOT NULL REFERENCES items (id) ON DELETE CASCADE,
        field      TEXT    NOT NULL,
        old_value  TEXT,
        new_value  TEXT,
        changed_at TEXT    NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_item_changes_item_id ON item_changes (item_id, changed_at DESC);
    `;

    const dbPath = path.join(workDir, "pre-kind-column.db");
    const legacy = new Database(dbPath);
    legacy.exec(PRE_KIND_COLUMN_SCHEMA_SQL);
    legacy
      .prepare(
        `INSERT INTO items (id, court, case_no, item_no, min_bid_price, auction_date,
                            first_seen_at, last_seen_at)
         VALUES (1, '서울중앙지방법원', '2025타경1', '1', 400000000, '2026-11-01',
                 '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
      )
      .run();
    // 기준점 행(진짜 기준점)과, 마이그레이션 전에는 기준점과 구별할 수 없었던
    // "null→값" 실제 변경 행을 둘 다 옛 스키마 그대로 심어 둔다 — 마이그레이션이 이
    // 둘을 구별해 주지는 못하지만(소급 불가, design.md 리스크), 적어도 기존 관례
    // (old_value IS NULL = 기준점)로 조용히 백필되는지는 확인할 수 있다.
    legacy
      .prepare(
        `INSERT INTO item_changes (item_id, field, old_value, new_value, changed_at)
         VALUES (1, 'minBidPrice', NULL, '400000000', '2026-01-01T00:00:00.000Z')`,
      )
      .run();
    legacy
      .prepare(
        `INSERT INTO item_changes (item_id, field, old_value, new_value, changed_at)
         VALUES (1, 'auctionDate', '2026-10-01', '2026-11-01', '2026-01-02T00:00:00.000Z')`,
      )
      .run();
    const legacyColumns = legacy
      .prepare<[], { name: string }>("PRAGMA table_info(item_changes)")
      .all()
      .map((row) => row.name);
    legacy.close();

    // 사전 조건: 옛 DB의 item_changes에는 kind 컬럼이 없다.
    expect(legacyColumns).not.toContain("kind");

    // 새 코드로 다시 열기 = 마이그레이션. 던지지 않아야 한다.
    const upgraded = openDatabase(dbPath);
    try {
      const columns = upgraded
        .prepare<[], { name: string }>("PRAGMA table_info(item_changes)")
        .all()
        .map((row) => row.name);
      expect(columns).toContain("kind");

      const repo = createRepository(upgraded);
      const changes = repo.listItemChanges(1);
      expect(changes).toHaveLength(2);
      // old_value가 NULL이던 행은 기존 관례대로 baseline으로 백필된다.
      expect(changes.find((c) => c.field === "minBidPrice")).toMatchObject({
        oldValue: null,
        kind: "baseline",
      });
      // old_value가 값이 있던 행(진짜 실제 변경)은 change로 백필된다.
      expect(changes.find((c) => c.field === "auctionDate")).toMatchObject({
        oldValue: "2026-10-01",
        kind: "change",
      });

      // 마이그레이션 이후에 새로 기록되는 행은 이제 baseline/change가 kind로 명시적으로
      // 구별된다(더 이상 old_value IS NULL 하나에 기대지 않는다).
      repo.upsertItems([
        {
          court: "서울중앙지방법원",
          caseNo: "2025타경1",
          itemNo: "1",
          address: null,
          usageType: null,
          appraisalPrice: null,
          minBidPrice: 400000000,
          auctionDate: null, // 기존 값은 '2026-11-01'이었으니 null로 바뀌는 것도 실제 변경
          failedBidCount: null,
          status: null,
        },
      ]);
      const auctionDateChanges = repo
        .listItemChanges(1)
        .filter((c) => c.field === "auctionDate");
      expect(auctionDateChanges).toHaveLength(2); // 마이그레이션 백필 1건 + 새 변경 1건
      expect(auctionDateChanges[1]).toMatchObject({
        oldValue: "2026-11-01",
        newValue: null,
        kind: "change",
      });
    } finally {
      upgraded.close();
    }
  });

  /**
   * 마이그레이션 경로 확인(4, add-collection-observability): `worker_runs` 테이블이
   * 추가되기 **직전** 스키마(이 change 이전의 최신 스키마 — items/analyses/item_changes와
   * `item_changes.kind` 컬럼까지는 있지만 worker_runs는 없다)로 만든 기존 DB 파일을 새
   * 코드로 열었을 때, 오류 없이 새 테이블·인덱스만 추가되고 기존 물건 데이터가 보존되는지
   * 확인한다. `CREATE TABLE IF NOT EXISTS`만으로 충분한 경우라 client.ts에 별도
   * `migrate*` 함수는 필요 없다(item_changes 테이블이 처음 추가됐을 때와 같은 경로).
   */
  it("worker_runs 테이블 추가 전 스키마로 만든 기존 DB 파일에 새 테이블이 그대로 적용된다", () => {
    const PRE_WORKER_RUNS_SCHEMA_SQL = `
      CREATE TABLE IF NOT EXISTS items (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        court             TEXT    NOT NULL,
        case_no           TEXT    NOT NULL,
        item_no           TEXT    NOT NULL,
        address           TEXT,
        usage_type        TEXT,
        appraisal_price   INTEGER,
        min_bid_price     INTEGER,
        auction_date      TEXT,
        failed_bid_count  INTEGER,
        status            TEXT,
        first_seen_at     TEXT    NOT NULL,
        last_seen_at      TEXT    NOT NULL,
        UNIQUE (court, case_no, item_no)
      );
      CREATE INDEX IF NOT EXISTS idx_items_auction_date ON items (auction_date);
      CREATE INDEX IF NOT EXISTS idx_items_usage_type ON items (usage_type);
      CREATE INDEX IF NOT EXISTS idx_items_min_bid_price ON items (min_bid_price);
      CREATE TABLE IF NOT EXISTS analyses (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        item_id        INTEGER NOT NULL REFERENCES items (id) ON DELETE CASCADE,
        body           TEXT    NOT NULL,
        model          TEXT,
        prompt_version TEXT    NOT NULL,
        analyzed_at    TEXT    NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_analyses_item_id ON analyses (item_id, analyzed_at DESC);
      CREATE TABLE IF NOT EXISTS item_changes (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        item_id    INTEGER NOT NULL REFERENCES items (id) ON DELETE CASCADE,
        field      TEXT    NOT NULL,
        old_value  TEXT,
        new_value  TEXT,
        changed_at TEXT    NOT NULL,
        kind       TEXT    NOT NULL DEFAULT 'change'
      );
      CREATE INDEX IF NOT EXISTS idx_item_changes_item_id ON item_changes (item_id, changed_at DESC);
    `;

    const dbPath = path.join(workDir, "pre-worker-runs.db");
    const legacy = new Database(dbPath);
    legacy.exec(PRE_WORKER_RUNS_SCHEMA_SQL);
    legacy
      .prepare(
        `INSERT INTO items (court, case_no, item_no, usage_type, min_bid_price,
                            first_seen_at, last_seen_at)
         VALUES ('서울중앙지방법원', '2025타경1', '1', '아파트', 400000000,
                 '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
      )
      .run();
    const legacyTables = legacy
      .prepare<[], { name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => row.name);
    legacy.close();

    // 사전 조건: 옛 DB에는 worker_runs가 없다.
    expect(legacyTables).not.toContain("worker_runs");

    // 새 코드로 다시 열기 = 마이그레이션. 던지지 않아야 한다.
    const upgraded = openDatabase(dbPath);
    try {
      const names = upgraded
        .prepare<[], { name: string }>(
          "SELECT name FROM sqlite_master WHERE type IN ('table', 'index')",
        )
        .all()
        .map((row) => row.name);
      expect(names).toContain("worker_runs");
      expect(names).toContain("idx_worker_runs_worker_started_at");

      // 기존 물건 데이터가 그대로 남아 있다.
      const repo = createRepository(upgraded);
      const result = repo.listItems({ pageSize: 10 });
      expect(result.total).toBe(1);
      expect(result.items[0]?.caseNo).toBe("2025타경1");

      // 새로 추가된 테이블에 정상적으로 쓰고 읽을 수 있다.
      upgraded
        .prepare(
          `INSERT INTO worker_runs (worker, started_at, outcome, created_at)
           VALUES ('collector', '2026-01-01T00:00:00.000Z', 'running', '2026-01-01T00:00:00.000Z')`,
        )
        .run();
      const runs = upgraded.prepare("SELECT * FROM worker_runs").all();
      expect(runs).toHaveLength(1);
    } finally {
      upgraded.close();
    }
  });
});

describe("openDatabase — items 확장 컬럼 마이그레이션 (enrich-item-fields)", () => {
  /**
   * 마이그레이션 경로 확인(5, enrich-item-fields task 2.2): `items`의 확장 컬럼이
   * 추가되기 **직전** 스키마(이 change 이전의 최신 스키마 — worker_runs까지는 있지만
   * 확장 컬럼은 없다)로 물건·이력·분석을 채운 DB 파일을 새 코드로 열었을 때, 오류 없이
   * 새 컬럼만 추가되고 기존 데이터(물건·이력·분석)가 그대로 보존되며 새 컬럼이 전부
   * NULL인지 확인한다.
   */
  it("items 확장 컬럼 추가 전 스키마로 만든 기존 DB 파일에 새 컬럼이 그대로 적용되고 기존 데이터가 보존된다", () => {
    const PRE_EXTENDED_FIELDS_SCHEMA_SQL = `
      CREATE TABLE IF NOT EXISTS items (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        court             TEXT    NOT NULL,
        case_no           TEXT    NOT NULL,
        item_no           TEXT    NOT NULL,
        address           TEXT,
        usage_type        TEXT,
        appraisal_price   INTEGER,
        min_bid_price     INTEGER,
        auction_date      TEXT,
        failed_bid_count  INTEGER,
        status            TEXT,
        first_seen_at     TEXT    NOT NULL,
        last_seen_at      TEXT    NOT NULL,
        UNIQUE (court, case_no, item_no)
      );
      CREATE INDEX IF NOT EXISTS idx_items_auction_date ON items (auction_date);
      CREATE INDEX IF NOT EXISTS idx_items_usage_type ON items (usage_type);
      CREATE INDEX IF NOT EXISTS idx_items_min_bid_price ON items (min_bid_price);
      CREATE TABLE IF NOT EXISTS analyses (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        item_id        INTEGER NOT NULL REFERENCES items (id) ON DELETE CASCADE,
        body           TEXT    NOT NULL,
        model          TEXT,
        prompt_version TEXT    NOT NULL,
        analyzed_at    TEXT    NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_analyses_item_id ON analyses (item_id, analyzed_at DESC);
      CREATE TABLE IF NOT EXISTS item_changes (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        item_id    INTEGER NOT NULL REFERENCES items (id) ON DELETE CASCADE,
        field      TEXT    NOT NULL,
        old_value  TEXT,
        new_value  TEXT,
        changed_at TEXT    NOT NULL,
        kind       TEXT    NOT NULL DEFAULT 'change'
      );
      CREATE INDEX IF NOT EXISTS idx_item_changes_item_id ON item_changes (item_id, changed_at DESC);
      CREATE TABLE IF NOT EXISTS worker_runs (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        worker        TEXT    NOT NULL,
        started_at    TEXT    NOT NULL,
        finished_at   TEXT,
        outcome       TEXT    NOT NULL,
        error_kind    TEXT,
        error_message TEXT,
        detail        TEXT,
        items_changed INTEGER,
        created_at    TEXT    NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_worker_runs_worker_started_at ON worker_runs (worker, started_at DESC);
    `;

    const dbPath = path.join(workDir, "pre-extended-fields.db");
    const legacy = new Database(dbPath);
    legacy.exec(PRE_EXTENDED_FIELDS_SCHEMA_SQL);
    legacy
      .prepare(
        `INSERT INTO items (id, court, case_no, item_no, usage_type, min_bid_price,
                            first_seen_at, last_seen_at)
         VALUES (1, '서울중앙지방법원', '2025타경1', '1', '아파트', 400000000,
                 '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
      )
      .run();
    legacy
      .prepare(
        `INSERT INTO item_changes (item_id, field, old_value, new_value, changed_at, kind)
         VALUES (1, 'minBidPrice', NULL, '400000000', '2026-01-01T00:00:00.000Z', 'baseline')`,
      )
      .run();
    legacy
      .prepare(
        `INSERT INTO analyses (item_id, body, model, prompt_version, analyzed_at)
         VALUES (1, '분석 본문', 'claude', 'v1', '2026-01-02T00:00:00.000Z')`,
      )
      .run();
    const legacyColumns = legacy
      .prepare<[], { name: string }>("PRAGMA table_info(items)")
      .all()
      .map((row) => row.name);
    legacy.close();

    // 사전 조건: 옛 DB의 items에는 확장 컬럼이 없다.
    expect(legacyColumns).not.toContain("min_area");
    expect(legacyColumns).not.toContain("status_code");

    // 새 코드로 다시 열기 = 마이그레이션. 던지지 않아야 한다.
    const upgraded = openDatabase(dbPath);
    try {
      const columns = upgraded
        .prepare<[], { name: string }>("PRAGMA table_info(items)")
        .all()
        .map((row) => row.name);
      expect(columns).toContain("min_area");
      expect(columns).toContain("building_description");
      expect(columns).toContain("min_bid_price_round1");
      expect(columns).toContain("min_bid_price_round4");
      expect(columns).toContain("min_bid_price_rate_round2");
      expect(columns).toContain("usage_code_small");
      expect(columns).toContain("coordinate_level");
      expect(columns).toContain("auction_decision_date");
      expect(columns).toContain("status_code");
      expect(columns).toContain("item_status_code");

      // 기존 물건·이력·분석 데이터가 전부 그대로 살아 있다.
      const repo = createRepository(upgraded);
      const result = repo.listItems({ pageSize: 10 });
      expect(result.total).toBe(1);
      const item = result.items[0]!;
      expect(item.caseNo).toBe("2025타경1");
      expect(item.minBidPrice).toBe(400000000);
      expect(repo.listItemChanges(item.id)).toHaveLength(1);
      expect(repo.countAnalyses(item.id)).toBe(1);
      expect(repo.getLatestAnalysis(item.id)?.body).toBe("분석 본문");

      // 새 컬럼은 전부 NULL이다 — 이 마이그레이션은 값을 소급하지 않는다(design.md D1).
      expect(item.minArea).toBeNull();
      expect(item.buildingDescription).toBeNull();
      expect(item.minBidPriceRound1).toBeNull();
      expect(item.usageCodeLarge).toBeNull();
      expect(item.sido).toBeNull();
      expect(item.coordinateX).toBeNull();
      expect(item.auctionDecisionDate).toBeNull();
      expect(item.note).toBeNull();
      expect(item.statusCode).toBeNull();
      expect(item.itemStatusCode).toBeNull();

      // 새 컬럼에 정상적으로 쓰고 읽을 수 있다(다음 수집으로 채워지는 경로).
      repo.upsertItems([
        {
          court: "서울중앙지방법원",
          caseNo: "2025타경1",
          itemNo: "1",
          address: null,
          usageType: "아파트",
          appraisalPrice: null,
          minBidPrice: 400000000,
          auctionDate: null,
          failedBidCount: null,
          status: null,
          minArea: 84,
          statusCode: "0002100001",
        },
      ]);
      const updated = repo.getItemById(item.id)!;
      expect(updated.minArea).toBe(84);
      expect(updated.statusCode).toBe("0002100001");
    } finally {
      upgraded.close();
    }
  });
});

describe("openDatabase — items 상세 조회 식별자 컬럼 마이그레이션 (add-item-photos stage A.2)", () => {
  /**
   * 마이그레이션 경로 확인(8, add-item-photos task A.2): `items`의 상세 조회 식별자
   * 컬럼(`internal_case_no`/`court_code`)이 추가되기 **직전** 스키마(이 change 이전의
   * 최신 스키마 — 확장 컬럼·bookmarks/feed_reads·collector_state까지는 있지만 상세 조회
   * 식별자 컬럼은 없다)로 물건·이력·분석·관심 등록을 채운 DB 파일을 새 코드로 열었을 때,
   * 오류 없이 새 컬럼만 추가되고 기존 데이터가 그대로 보존되며 새 컬럼이 전부 NULL인지
   * 확인한다.
   */
  it("상세 조회 식별자 컬럼 추가 전 스키마로 만든 기존 DB 파일에 새 컬럼이 그대로 적용되고 기존 데이터가 보존된다", () => {
    const PRE_DETAIL_IDENTIFIER_SCHEMA_SQL = `
      CREATE TABLE IF NOT EXISTS items (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        court             TEXT    NOT NULL,
        case_no           TEXT    NOT NULL,
        item_no           TEXT    NOT NULL,
        address           TEXT,
        usage_type        TEXT,
        appraisal_price   INTEGER,
        min_bid_price     INTEGER,
        auction_date      TEXT,
        failed_bid_count  INTEGER,
        status            TEXT,
        first_seen_at     TEXT    NOT NULL,
        last_seen_at      TEXT    NOT NULL,
        min_area                  INTEGER,
        max_area                  INTEGER,
        building_description      TEXT,
        min_bid_price_round1      INTEGER,
        min_bid_price_round2      INTEGER,
        min_bid_price_round3      INTEGER,
        min_bid_price_round4      INTEGER,
        min_bid_price_rate_round1 INTEGER,
        min_bid_price_rate_round2 INTEGER,
        usage_code_large          TEXT,
        usage_code_medium         TEXT,
        usage_code_small          TEXT,
        sido                      TEXT,
        sigungu                   TEXT,
        dong                      TEXT,
        lot_number                TEXT,
        building_name             TEXT,
        building_unit             TEXT,
        coordinate_x              TEXT,
        coordinate_y              TEXT,
        coordinate_level          TEXT,
        auction_time              TEXT,
        auction_place             TEXT,
        auction_decision_date     TEXT,
        auction_round             INTEGER,
        note                      TEXT,
        duplicate_case_no         TEXT,
        merged_case_no            TEXT,
        court_department          TEXT,
        court_phone               TEXT,
        status_code               TEXT,
        item_status_code          TEXT,
        UNIQUE (court, case_no, item_no)
      );
      CREATE INDEX IF NOT EXISTS idx_items_auction_date ON items (auction_date);
      CREATE INDEX IF NOT EXISTS idx_items_usage_type ON items (usage_type);
      CREATE INDEX IF NOT EXISTS idx_items_min_bid_price ON items (min_bid_price);
      CREATE TABLE IF NOT EXISTS analyses (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        item_id        INTEGER NOT NULL REFERENCES items (id) ON DELETE CASCADE,
        body           TEXT    NOT NULL,
        model          TEXT,
        prompt_version TEXT    NOT NULL,
        analyzed_at    TEXT    NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_analyses_item_id ON analyses (item_id, analyzed_at DESC);
      CREATE TABLE IF NOT EXISTS item_changes (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        item_id    INTEGER NOT NULL REFERENCES items (id) ON DELETE CASCADE,
        field      TEXT    NOT NULL,
        old_value  TEXT,
        new_value  TEXT,
        changed_at TEXT    NOT NULL,
        kind       TEXT    NOT NULL DEFAULT 'change'
      );
      CREATE INDEX IF NOT EXISTS idx_item_changes_item_id ON item_changes (item_id, changed_at DESC);
      CREATE TABLE IF NOT EXISTS worker_runs (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        worker        TEXT    NOT NULL,
        started_at    TEXT    NOT NULL,
        finished_at   TEXT,
        outcome       TEXT    NOT NULL,
        error_kind    TEXT,
        error_message TEXT,
        detail        TEXT,
        items_changed INTEGER,
        created_at    TEXT    NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_worker_runs_worker_started_at ON worker_runs (worker, started_at DESC);
      CREATE TABLE IF NOT EXISTS bookmarks (
        item_id    INTEGER PRIMARY KEY REFERENCES items (id) ON DELETE CASCADE,
        created_at TEXT    NOT NULL
      );
      CREATE TABLE IF NOT EXISTS feed_reads (
        id           INTEGER PRIMARY KEY CHECK (id = 1),
        last_read_at TEXT
      );
      CREATE TABLE IF NOT EXISTS collector_state (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `;

    const dbPath = path.join(workDir, "pre-detail-identifiers.db");
    const legacy = new Database(dbPath);
    legacy.exec(PRE_DETAIL_IDENTIFIER_SCHEMA_SQL);
    legacy
      .prepare(
        `INSERT INTO items (id, court, case_no, item_no, usage_type, min_bid_price,
                            min_area, status_code, first_seen_at, last_seen_at)
         VALUES (1, '서울중앙지방법원', '2011타경28497', '1', '아파트', 711000000,
                 84, '0002100001', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
      )
      .run();
    legacy
      .prepare(
        `INSERT INTO item_changes (item_id, field, old_value, new_value, changed_at, kind)
         VALUES (1, 'minBidPrice', NULL, '711000000', '2026-01-01T00:00:00.000Z', 'baseline')`,
      )
      .run();
    legacy
      .prepare(
        `INSERT INTO analyses (item_id, body, model, prompt_version, analyzed_at)
         VALUES (1, '분석 본문', 'claude', 'v1', '2026-01-02T00:00:00.000Z')`,
      )
      .run();
    legacy
      .prepare(`INSERT INTO bookmarks (item_id, created_at) VALUES (1, '2026-01-03T00:00:00.000Z')`)
      .run();
    const legacyColumns = legacy
      .prepare<[], { name: string }>("PRAGMA table_info(items)")
      .all()
      .map((row) => row.name);
    legacy.close();

    // 사전 조건: 옛 DB의 items에는 상세 조회 식별자 컬럼이 없다.
    expect(legacyColumns).not.toContain("internal_case_no");
    expect(legacyColumns).not.toContain("court_code");
    // 사전 조건: 기존 확장 컬럼은 이미 있다(이 마이그레이션보다 먼저 적용된 상태).
    expect(legacyColumns).toContain("min_area");
    expect(legacyColumns).toContain("status_code");

    // 새 코드로 다시 열기 = 마이그레이션. 던지지 않아야 한다.
    const upgraded = openDatabase(dbPath);
    try {
      const columns = upgraded
        .prepare<[], { name: string }>("PRAGMA table_info(items)")
        .all()
        .map((row) => row.name);
      expect(columns).toContain("internal_case_no");
      expect(columns).toContain("court_code");

      // 기존 물건·이력·분석·관심 등록 데이터가 전부 그대로 살아 있다.
      const repo = createRepository(upgraded);
      const result = repo.listItems({ pageSize: 10 });
      expect(result.total).toBe(1);
      const item = result.items[0]!;
      expect(item.caseNo).toBe("2011타경28497");
      expect(item.minBidPrice).toBe(711000000);
      expect(item.minArea).toBe(84); // 기존 확장 컬럼 데이터도 그대로.
      expect(item.statusCode).toBe("0002100001");
      expect(item.bookmarked).toBe(true);
      expect(repo.listItemChanges(item.id)).toHaveLength(1);
      expect(repo.countAnalyses(item.id)).toBe(1);
      expect(repo.getLatestAnalysis(item.id)?.body).toBe("분석 본문");

      // 새 컬럼은 전부 NULL이다 — 이 마이그레이션은 값을 소급하지 않는다.
      expect(item.internalCaseNo).toBeNull();
      expect(item.courtCode).toBeNull();

      // 새 컬럼에 정상적으로 쓰고 읽을 수 있다(다음 수집으로 채워지는 경로).
      repo.upsertItems([
        {
          court: "서울중앙지방법원",
          caseNo: "2011타경28497",
          itemNo: "1",
          address: null,
          usageType: "아파트",
          appraisalPrice: null,
          minBidPrice: 711000000,
          auctionDate: null,
          failedBidCount: null,
          status: null,
          internalCaseNo: "20110130028497",
          courtCode: "B000210",
        },
      ]);
      const updated = repo.getItemById(item.id)!;
      expect(updated.internalCaseNo).toBe("20110130028497");
      expect(updated.courtCode).toBe("B000210");
    } finally {
      upgraded.close();
    }
  });
});

describe("resolveDbPath", () => {
  const originalEnv = process.env.AUCTIONBOSS_DB;

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.AUCTIONBOSS_DB;
    else process.env.AUCTIONBOSS_DB = originalEnv;
  });

  it("기본값은 <cwd>/data/auctionboss.db 이다", () => {
    delete process.env.AUCTIONBOSS_DB;
    expect(resolveDbPath()).toBe(path.resolve(process.cwd(), DEFAULT_DB_PATH));
  });

  it("AUCTIONBOSS_DB 환경 변수가 기본값을 덮어쓴다", () => {
    process.env.AUCTIONBOSS_DB = path.join(workDir, "custom.db");
    expect(resolveDbPath()).toBe(path.join(workDir, "custom.db"));
  });

  it("명시한 경로가 환경 변수보다 우선한다", () => {
    process.env.AUCTIONBOSS_DB = "env.db";
    expect(resolveDbPath("explicit.db")).toBe(path.resolve(process.cwd(), "explicit.db"));
  });
});

describe("openDatabase — bookmarks/feed_reads 마이그레이션 (add-bookmarks-and-feed task 1.2)", () => {
  /**
   * 마이그레이션 경로 확인(6): `bookmarks`/`feed_reads` 테이블이 추가되기 **직전** 스키마
   * (이 change 이전의 최신 스키마 — items 확장 컬럼까지는 있지만 관심 물건 관련 테이블은
   * 없다)로 물건·이력·분석을 채운 DB 파일을 새 코드로 열었을 때, 오류 없이 새 테이블만
   * 추가되고 기존 데이터가 그대로 보존되는지 확인한다. `bookmarks`/`feed_reads`는 완전히
   * 새 테이블이라(기존 테이블 컬럼 추가가 아니다) `CREATE TABLE IF NOT EXISTS`만으로 충분하고
   * `client.ts`에 별도 `migrate*` 함수가 필요 없다(item_changes/worker_runs 테이블이 처음
   * 추가됐을 때와 같은 경로).
   */
  it("bookmarks/feed_reads 추가 전 스키마로 만든 기존 DB 파일에 새 테이블이 그대로 적용되고 기존 데이터가 보존된다", () => {
    const PRE_BOOKMARKS_SCHEMA_SQL = `
      CREATE TABLE IF NOT EXISTS items (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        court             TEXT    NOT NULL,
        case_no           TEXT    NOT NULL,
        item_no           TEXT    NOT NULL,
        address           TEXT,
        usage_type        TEXT,
        appraisal_price   INTEGER,
        min_bid_price     INTEGER,
        auction_date      TEXT,
        failed_bid_count  INTEGER,
        status            TEXT,
        first_seen_at     TEXT    NOT NULL,
        last_seen_at      TEXT    NOT NULL,
        UNIQUE (court, case_no, item_no)
      );
      CREATE INDEX IF NOT EXISTS idx_items_auction_date ON items (auction_date);
      CREATE INDEX IF NOT EXISTS idx_items_usage_type ON items (usage_type);
      CREATE INDEX IF NOT EXISTS idx_items_min_bid_price ON items (min_bid_price);
      CREATE TABLE IF NOT EXISTS analyses (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        item_id        INTEGER NOT NULL REFERENCES items (id) ON DELETE CASCADE,
        body           TEXT    NOT NULL,
        model          TEXT,
        prompt_version TEXT    NOT NULL,
        analyzed_at    TEXT    NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_analyses_item_id ON analyses (item_id, analyzed_at DESC);
      CREATE TABLE IF NOT EXISTS item_changes (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        item_id    INTEGER NOT NULL REFERENCES items (id) ON DELETE CASCADE,
        field      TEXT    NOT NULL,
        old_value  TEXT,
        new_value  TEXT,
        changed_at TEXT    NOT NULL,
        kind       TEXT    NOT NULL DEFAULT 'change'
      );
      CREATE INDEX IF NOT EXISTS idx_item_changes_item_id ON item_changes (item_id, changed_at DESC);
      CREATE TABLE IF NOT EXISTS worker_runs (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        worker        TEXT    NOT NULL,
        started_at    TEXT    NOT NULL,
        finished_at   TEXT,
        outcome       TEXT    NOT NULL,
        error_kind    TEXT,
        error_message TEXT,
        detail        TEXT,
        items_changed INTEGER,
        created_at    TEXT    NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_worker_runs_worker_started_at ON worker_runs (worker, started_at DESC);
    `;

    const dbPath = path.join(workDir, "pre-bookmarks.db");
    const legacy = new Database(dbPath);
    legacy.exec(PRE_BOOKMARKS_SCHEMA_SQL);
    legacy
      .prepare(
        `INSERT INTO items (id, court, case_no, item_no, usage_type, min_bid_price,
                            first_seen_at, last_seen_at)
         VALUES (1, '서울중앙지방법원', '2025타경1', '1', '아파트', 400000000,
                 '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
      )
      .run();
    legacy
      .prepare(
        `INSERT INTO item_changes (item_id, field, old_value, new_value, changed_at, kind)
         VALUES (1, 'minBidPrice', NULL, '400000000', '2026-01-01T00:00:00.000Z', 'baseline')`,
      )
      .run();
    legacy
      .prepare(
        `INSERT INTO analyses (item_id, body, model, prompt_version, analyzed_at)
         VALUES (1, '분석 본문', 'claude', 'v1', '2026-01-02T00:00:00.000Z')`,
      )
      .run();
    const legacyTables = legacy
      .prepare<[], { name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => row.name);
    legacy.close();

    // 사전 조건: 옛 DB에는 bookmarks/feed_reads가 없다.
    expect(legacyTables).not.toContain("bookmarks");
    expect(legacyTables).not.toContain("feed_reads");

    // 새 코드로 다시 열기 = 마이그레이션. 던지지 않아야 한다.
    const upgraded = openDatabase(dbPath);
    try {
      const names = upgraded
        .prepare<[], { name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((row) => row.name);
      expect(names).toContain("bookmarks");
      expect(names).toContain("feed_reads");

      // 기존 물건·이력·분석 데이터가 전부 그대로 살아 있다.
      const repo = createRepository(upgraded);
      const result = repo.listItems({ pageSize: 10 });
      expect(result.total).toBe(1);
      expect(result.items[0]?.caseNo).toBe("2025타경1");
      expect(repo.listItemChanges(result.items[0]!.id)).toHaveLength(1);
      expect(repo.countAnalyses(result.items[0]!.id)).toBe(1);

      // 새 테이블에 정상적으로 쓰고 읽을 수 있다.
      upgraded
        .prepare(`INSERT INTO bookmarks (item_id, created_at) VALUES (1, '2026-01-03T00:00:00.000Z')`)
        .run();
      expect(upgraded.prepare("SELECT * FROM bookmarks").all()).toHaveLength(1);
    } finally {
      upgraded.close();
    }
  });
});

describe("openDatabase — collector_state 마이그레이션 (scale-collection-scheduling task 1.2)", () => {
  /**
   * 마이그레이션 경로 확인(7): `collector_state` 테이블이 추가되기 **직전** 스키마
   * (이 change 이전의 최신 스키마 — bookmarks/feed_reads까지는 있지만 collector_state는
   * 없다)로 물건 데이터를 채운 DB 파일을 새 코드로 열었을 때, 오류 없이 새 테이블만
   * 추가되고 기존 데이터가 그대로 보존되는지 확인한다. 완전히 새 테이블이라(기존 테이블
   * 컬럼 추가가 아니다) `CREATE TABLE IF NOT EXISTS`만으로 충분하고 `client.ts`에 별도
   * `migrate*` 함수가 필요 없다.
   */
  it("collector_state 추가 전 스키마로 만든 기존 DB 파일에 새 테이블이 그대로 적용되고 기존 데이터가 보존된다", () => {
    const PRE_COLLECTOR_STATE_SCHEMA_SQL = `
      CREATE TABLE IF NOT EXISTS items (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        court             TEXT    NOT NULL,
        case_no           TEXT    NOT NULL,
        item_no           TEXT    NOT NULL,
        address           TEXT,
        usage_type        TEXT,
        appraisal_price   INTEGER,
        min_bid_price     INTEGER,
        auction_date      TEXT,
        failed_bid_count  INTEGER,
        status            TEXT,
        first_seen_at     TEXT    NOT NULL,
        last_seen_at      TEXT    NOT NULL,
        UNIQUE (court, case_no, item_no)
      );
      CREATE INDEX IF NOT EXISTS idx_items_auction_date ON items (auction_date);
      CREATE INDEX IF NOT EXISTS idx_items_usage_type ON items (usage_type);
      CREATE INDEX IF NOT EXISTS idx_items_min_bid_price ON items (min_bid_price);
      CREATE TABLE IF NOT EXISTS analyses (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        item_id        INTEGER NOT NULL REFERENCES items (id) ON DELETE CASCADE,
        body           TEXT    NOT NULL,
        model          TEXT,
        prompt_version TEXT    NOT NULL,
        analyzed_at    TEXT    NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_analyses_item_id ON analyses (item_id, analyzed_at DESC);
      CREATE TABLE IF NOT EXISTS item_changes (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        item_id    INTEGER NOT NULL REFERENCES items (id) ON DELETE CASCADE,
        field      TEXT    NOT NULL,
        old_value  TEXT,
        new_value  TEXT,
        changed_at TEXT    NOT NULL,
        kind       TEXT    NOT NULL DEFAULT 'change'
      );
      CREATE INDEX IF NOT EXISTS idx_item_changes_item_id ON item_changes (item_id, changed_at DESC);
      CREATE TABLE IF NOT EXISTS worker_runs (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        worker        TEXT    NOT NULL,
        started_at    TEXT    NOT NULL,
        finished_at   TEXT,
        outcome       TEXT    NOT NULL,
        error_kind    TEXT,
        error_message TEXT,
        detail        TEXT,
        items_changed INTEGER,
        created_at    TEXT    NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_worker_runs_worker_started_at ON worker_runs (worker, started_at DESC);
    `;

    const dbPath = path.join(workDir, "pre-collector-state.db");
    const legacy = new Database(dbPath);
    legacy.exec(PRE_COLLECTOR_STATE_SCHEMA_SQL);
    legacy
      .prepare(
        `INSERT INTO items (id, court, case_no, item_no, usage_type, min_bid_price,
                            first_seen_at, last_seen_at)
         VALUES (1, '서울중앙지방법원', '2025타경1', '1', '아파트', 400000000,
                 '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
      )
      .run();
    const legacyTables = legacy
      .prepare<[], { name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => row.name);
    legacy.close();

    // 사전 조건: 옛 DB에는 collector_state가 없다.
    expect(legacyTables).not.toContain("collector_state");

    // 새 코드로 다시 열기 = 마이그레이션. 던지지 않아야 한다.
    const upgraded = openDatabase(dbPath);
    try {
      const names = upgraded
        .prepare<[], { name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((row) => row.name);
      expect(names).toContain("collector_state");

      // 기존 물건 데이터가 그대로 남아 있다.
      const repo = createRepository(upgraded);
      const result = repo.listItems({ pageSize: 10 });
      expect(result.total).toBe(1);
      expect(result.items[0]?.caseNo).toBe("2025타경1");

      // 새 테이블에 정상적으로 쓰고 읽을 수 있다.
      const stateRepo = createCollectorStateRepository(upgraded);
      expect(stateRepo.getCollectorState("some-key")).toBeNull();
      stateRepo.setCollectorState("some-key", "B000210");
      expect(stateRepo.getCollectorState("some-key")).toBe("B000210");
    } finally {
      upgraded.close();
    }
  });
});
