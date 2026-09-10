/**
 * SQLite 연결 관리.
 *
 * - 파일 경로: env `AUCTIONBOSS_DB` > `<cwd>/data/auctionboss.db`
 * - WAL 모드: 쓰기 주체가 collector 워커와 API 서버 둘이라 읽기-쓰기 잠금 충돌을 줄인다.
 * - 싱글턴: 모듈을 여러 번 import해도 파일을 다시 열지 않는다. Next.js dev의 HMR은
 *   모듈을 통째로 다시 평가하므로 모듈 변수만으로는 연결이 새기 때문에 `globalThis`에 건다.
 */
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";

import { SCHEMA_SQL } from "./schema";

export type Db = Database.Database;

export const DEFAULT_DB_PATH = "data/auctionboss.db";

/** better-sqlite3가 파일을 만들지 않는 특수 경로(임시/인메모리 DB). */
function isFilelessPath(dbPath: string): boolean {
  return dbPath === ":memory:" || dbPath === "";
}

export function resolveDbPath(explicitPath?: string): string {
  const raw = explicitPath ?? process.env.AUCTIONBOSS_DB ?? DEFAULT_DB_PATH;
  if (isFilelessPath(raw)) return raw;
  return path.resolve(process.cwd(), raw);
}

/**
 * `item_changes.kind` 컬럼 마이그레이션 (코드 리뷰 finding 1).
 *
 * 이 컬럼이 추가되기 전에 만들어진 DB 파일에는 컬럼 자체가 없다 — `CREATE TABLE IF NOT
 * EXISTS`는 이미 있는 테이블에 컬럼을 추가해 주지 않으므로(SQLite), 여기서 직접
 * `ALTER TABLE ... ADD COLUMN`으로 마이그레이션한다. 새로 만드는 DB는 `SCHEMA_SQL`이
 * 이미 이 컬럼을 갖고 테이블을 만들므로 이 함수는 조용히 아무 것도 하지 않는다.
 *
 * 백필 규칙: 이 컬럼이 없던 시절에는 `old_value IS NULL` 하나로 기준점과 실제 변경을
 * 구별했다(그 방식 자체가 문제였다 — null→값 변화가 기준점과 섞이는 버그, finding 1).
 * 그 시절에 기록된 행이 실제로 어느 쪽이었는지는 소급해서 알 수 없으므로, 기존 관례
 * (`old_value IS NULL` = 기준점)를 그대로 백필 값으로 쓴다. 즉 이 마이그레이션 이전에
 * 저장된 "null→값" 변경은 백필 후에도 기준점으로 재분류된다 — design.md의 기존 리스크
 * ("기존 DB 마이그레이션 — 이미 저장된 물건들은 기준점 이력을 소급할 수 없다")의 연장선이다.
 * 이 마이그레이션이 고치는 것은 "이후로 기록되는 행"부터다.
 */
function migrateItemChangesKindColumn(db: Db): void {
  const columns = db.pragma("table_info(item_changes)") as Array<{ name: string }>;
  const hasKindColumn = columns.some((column) => column.name === "kind");
  if (hasKindColumn) return;

  db.exec(`
    ALTER TABLE item_changes ADD COLUMN kind TEXT NOT NULL DEFAULT 'change';
    UPDATE item_changes SET kind = 'baseline' WHERE old_value IS NULL;
  `);
}

/**
 * `items`의 확장 컬럼 마이그레이션 (enrich-item-fields, design.md D1).
 *
 * `item_changes.kind`와 같은 이유로 같은 방식을 쓴다: 이 컬럼들이 추가되기 전에 만들어진
 * DB 파일에는 컬럼 자체가 없고, `CREATE TABLE IF NOT EXISTS`는 이미 있는 테이블에
 * 컬럼을 추가해 주지 않으므로 `ALTER TABLE ... ADD COLUMN`으로 직접 추가한다. 새로
 * 만드는 DB는 `SCHEMA_SQL`이 이미 이 컬럼들을 갖고 테이블을 만들므로 이 함수는 조용히
 * 아무 것도 하지 않는다.
 *
 * 전부 nullable이라 백필이 없다 — 기존 행은 그대로 NULL로 남고 다음 수집 때 채워진다
 * (design.md D1: "이 change의 마이그레이션은 값을 소급하지 않는다 — 소급할 데이터가
 * 없다"). 컬럼 하나하나를 개별 `ALTER TABLE` 문으로 실행한다 — SQLite는 한 번에 여러
 * 컬럼을 추가하는 문법이 없고, 컬럼별로 존재 여부가 다를 수 있는 상황(예: 이 마이그레이션
 * 도중 실패했다가 재시도하는 경우)에도 안전하게 재실행되도록 하기 위함이다.
 */
function migrateItemExtendedFieldsColumns(db: Db): void {
  const columns = db.pragma("table_info(items)") as Array<{ name: string }>;
  const existing = new Set(columns.map((column) => column.name));

  const extendedColumns: Array<[name: string, ddl: string]> = [
    ["min_area", "INTEGER"],
    ["max_area", "INTEGER"],
    ["building_description", "TEXT"],
    ["min_bid_price_round1", "INTEGER"],
    ["min_bid_price_round2", "INTEGER"],
    ["min_bid_price_round3", "INTEGER"],
    ["min_bid_price_round4", "INTEGER"],
    ["min_bid_price_rate_round1", "INTEGER"],
    ["min_bid_price_rate_round2", "INTEGER"],
    ["usage_code_large", "TEXT"],
    ["usage_code_medium", "TEXT"],
    ["usage_code_small", "TEXT"],
    ["sido", "TEXT"],
    ["sigungu", "TEXT"],
    ["dong", "TEXT"],
    ["lot_number", "TEXT"],
    ["building_name", "TEXT"],
    ["building_unit", "TEXT"],
    ["coordinate_x", "TEXT"],
    ["coordinate_y", "TEXT"],
    ["coordinate_level", "TEXT"],
    ["auction_time", "TEXT"],
    ["auction_place", "TEXT"],
    ["auction_decision_date", "TEXT"],
    ["auction_round", "INTEGER"],
    ["note", "TEXT"],
    ["duplicate_case_no", "TEXT"],
    ["merged_case_no", "TEXT"],
    ["court_department", "TEXT"],
    ["court_phone", "TEXT"],
    ["status_code", "TEXT"],
    ["item_status_code", "TEXT"],
  ];

  for (const [name, ddl] of extendedColumns) {
    if (existing.has(name)) continue;
    db.exec(`ALTER TABLE items ADD COLUMN ${name} ${ddl}`);
  }
}

/**
 * `items`의 상세 조회 식별자 컬럼 마이그레이션 (add-item-photos stage A).
 *
 * `migrateItemExtendedFieldsColumns`와 같은 이유·같은 방식이다: 이 컬럼들이 추가되기
 * 전에 만들어진 DB 파일에는 컬럼 자체가 없고, `CREATE TABLE IF NOT EXISTS`는 이미 있는
 * 테이블에 컬럼을 추가해 주지 않으므로 `ALTER TABLE ... ADD COLUMN`으로 직접 추가한다.
 * 새로 만드는 DB는 `SCHEMA_SQL`이 이미 이 컬럼들을 갖고 테이블을 만들므로 이 함수는
 * 조용히 아무 것도 하지 않는다.
 *
 * 전부 nullable이라 백필이 없다 — 기존 행은 그대로 NULL로 남고 다음 수집 때 채워진다.
 */
function migrateItemDetailIdentifierColumns(db: Db): void {
  const columns = db.pragma("table_info(items)") as Array<{ name: string }>;
  const existing = new Set(columns.map((column) => column.name));

  const detailIdentifierColumns: Array<[name: string, ddl: string]> = [
    ["internal_case_no", "TEXT"],
    ["court_code", "TEXT"],
  ];

  for (const [name, ddl] of detailIdentifierColumns) {
    if (existing.has(name)) continue;
    db.exec(`ALTER TABLE items ADD COLUMN ${name} ${ddl}`);
  }
}

/**
 * DB 파일을 열고 pragma·스키마를 적용한 새 연결을 돌려준다.
 * 테스트는 이 함수에 임시 경로나 `":memory:"`를 직접 넘겨 env에 의존하지 않는다.
 */
export function openDatabase(dbPath: string): Db {
  if (!isFilelessPath(dbPath)) {
    mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new Database(dbPath);
  // 인메모리 DB에서는 WAL이 적용되지 않고 "memory"가 유지된다(오류는 아니다).
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA_SQL);
  migrateItemChangesKindColumn(db);
  migrateItemExtendedFieldsColumns(db);
  migrateItemDetailIdentifierColumns(db);
  return db;
}

interface DbGlobal {
  __auctionbossDb?: { path: string; db: Db };
}

const dbGlobal = globalThis as unknown as DbGlobal;

/** 기본 DB 연결(싱글턴). 앱과 워커는 이 함수만 쓴다. */
export function getDb(): Db {
  const dbPath = resolveDbPath();
  const cached = dbGlobal.__auctionbossDb;
  if (cached) {
    if (cached.path === dbPath && cached.db.open) return cached.db;
    // 경로가 바뀌었거나 연결이 닫혔으면 이전 것을 정리하고 다시 연다.
    if (cached.db.open) cached.db.close();
  }
  const db = openDatabase(dbPath);
  dbGlobal.__auctionbossDb = { path: dbPath, db };
  return db;
}

/** 싱글턴 연결을 닫는다. 워커 종료 처리·테스트 정리용. */
export function closeDb(): void {
  const cached = dbGlobal.__auctionbossDb;
  if (cached?.db.open) cached.db.close();
  dbGlobal.__auctionbossDb = undefined;
}
