/**
 * 컬럼 종류 판정과 테이블 순서 (시드 내보내기와 이전 내보내기가 함께 쓴다).
 * migrate-data-and-cutover D3: export-seed.ts의 판정을 공용 모듈로 옮겼다.
 */
import type Database from "better-sqlite3";

import type { SqlColumn, SqlColumnKind } from "./sql";

/** 시각 컬럼(ISO 문자열 TEXT -> DATETIME(3)). 이름만으로 판정한다. */
export const DATETIME_COLUMNS: ReadonlySet<string> = new Set([
  "first_seen_at",
  "last_seen_at",
  "photo_collected_at",
  // Flyway V2. 운영 원본에는 값이 있는 행이 있다 — 빠지면 ISO 문자열이 TEXT로 나가 DATETIME에 들어가지 않는다.
  "photo_attempted_at",
  "analyzed_at",
  "changed_at",
  "started_at",
  "finished_at",
  "created_at",
  "updated_at",
  "collected_at",
  "last_read_at",
]);
export const DATE_COLUMNS: ReadonlySet<string> = new Set(["auction_date", "auction_decision_date"]);
export const JSON_COLUMNS: ReadonlySet<string> = new Set(["detail"]);

export function columnKind(name: string, sqliteType: string): SqlColumnKind {
  if (DATETIME_COLUMNS.has(name)) return "datetime";
  if (DATE_COLUMNS.has(name)) return "date";
  if (JSON_COLUMNS.has(name)) return "json";
  return sqliteType.toUpperCase() === "INTEGER" ? "int" : "text";
}

export interface TableSpec {
  table: string;
  /** 기본 키 컬럼과 정렬 방식. `bytes`는 UTF-8 바이트 순(MySQL 콜레이션을 쓰지 않는다). */
  key: string;
  keyKind: "int" | "bytes";
}

/** FK 순서(items -> item_changes -> analyses -> worker_runs -> bookmarks -> feed_reads -> collector_state -> item_photos). */
export const TABLE_SPECS: readonly TableSpec[] = [
  { table: "items", key: "id", keyKind: "int" },
  { table: "item_changes", key: "id", keyKind: "int" },
  { table: "analyses", key: "id", keyKind: "int" },
  { table: "worker_runs", key: "id", keyKind: "int" },
  { table: "bookmarks", key: "item_id", keyKind: "int" },
  { table: "feed_reads", key: "id", keyKind: "int" },
  { table: "collector_state", key: "key", keyKind: "bytes" },
  { table: "item_photos", key: "id", keyKind: "int" },
];

/**
 * Flyway V1~V3 MySQL 테이블의 컬럼 순서(= 이전 SQL의 컬럼 순서, 행 해시의 값 순서).
 * 테스트가 마이그레이션 파일과 `schema.ts`로 만든 SQLite에서 같은 집합인지 확인한다.
 */
export const EXPECTED_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  items: ["id", "court", "case_no", "item_no", "address", "usage_type", "appraisal_price", "min_bid_price", "auction_date", "failed_bid_count", "status", "first_seen_at", "last_seen_at", "min_area", "max_area", "building_description", "min_bid_price_round1", "min_bid_price_round2", "min_bid_price_round3", "min_bid_price_round4", "min_bid_price_rate_round1", "min_bid_price_rate_round2", "usage_code_large", "usage_code_medium", "usage_code_small", "sido", "sigungu", "dong", "lot_number", "building_name", "building_unit", "coordinate_x", "coordinate_y", "coordinate_level", "auction_time", "auction_place", "auction_decision_date", "auction_round", "note", "duplicate_case_no", "merged_case_no", "court_department", "court_phone", "status_code", "item_status_code", "internal_case_no", "court_code", "photo_status", "photo_count", "photo_collected_at", "photo_attempted_at"],
  item_changes: ["id", "item_id", "field", "old_value", "new_value", "changed_at", "kind"],
  analyses: ["id", "item_id", "body", "model", "prompt_version", "analyzed_at"],
  worker_runs: ["id", "worker", "started_at", "finished_at", "outcome", "error_kind", "error_message", "detail", "items_changed", "created_at"],
  bookmarks: ["item_id", "created_at"],
  feed_reads: ["id", "last_read_at"],
  collector_state: ["key", "value", "updated_at"],
  item_photos: ["id", "item_id", "seq", "file_path", "file_size", "mime_type", "collected_at"],
};

/** SQLite 테이블의 컬럼을 이름·종류로 읽는다(SQLite 물리 순서). */
export function readColumns(db: Database.Database, table: string): SqlColumn[] {
  const info = db.prepare(`SELECT name, type FROM pragma_table_info('${table}')`).all() as { name: string; type: string }[];
  return info.map((c) => ({ name: c.name, kind: columnKind(c.name, c.type) }));
}
