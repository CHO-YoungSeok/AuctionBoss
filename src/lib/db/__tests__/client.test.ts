import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_DB_PATH, openDatabase, resolveDbPath } from "../client";

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
