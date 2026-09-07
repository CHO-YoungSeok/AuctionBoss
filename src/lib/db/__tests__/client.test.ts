import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

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
      expect(names).toContain("idx_items_auction_date");
      expect(names).toContain("idx_analyses_item_id");
      expect(names).toContain("idx_items_usage_type");
      expect(names).toContain("idx_items_min_bid_price");
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
