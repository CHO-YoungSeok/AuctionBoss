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
