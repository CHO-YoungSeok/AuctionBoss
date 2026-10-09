/**
 * 커밋된 시드 SQL(MySQL 방언)을 Next 스키마의 SQLite에 되돌려 적재한다 (add-spring-write-api D10).
 *
 * 시나리오 골든의 기반 데이터다. 운영 DB(data/auctionboss.db)를 읽지 않으므로 실명이 들어올 길이 없고,
 * 운영 DB가 시드 이후 바뀐 것에도 흔들리지 않는다. 스키마는 Next 자신의 `openDatabase`로 만든다.
 *
 * sql.ts(내보내기)의 역변환이다:
 *  - 백슬래시 이스케이프(\\ \' \n \r \0 \Z, 그 밖의 `\x`는 MySQL처럼 `x`)를 되돌린다.
 *  - 시각 컬럼 `'YYYY-MM-DD HH:MM:SS.mmm'`(UTC)을 ISO `YYYY-MM-DDTHH:MM:SS.mmmZ`로 되돌린다.
 *  - 날짜(`YYYY-MM-DD`)와 JSON(텍스트)은 그대로 둔다.
 *
 * SQL 전체를 문자열 리터럴 인식 스캐너로 읽는다. 문자열 안의 `;` `--` `(` 는 문법으로 보지 않는다.
 */
import type Database from "better-sqlite3";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { openDatabase } from "../../src/lib/db/client";
import { DATETIME_COLUMNS } from "./columns";

export { DATETIME_COLUMNS };

export const MYSQL_DATETIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/;

export const DEFAULT_SEED_DIR = path.resolve(__dirname, "../../backend/src/main/resources/db/seed");

export type SeedValue = string | number | null;

export interface SeedStatement {
  table: string;
  columns: string[];
  rows: SeedValue[][];
}

/** `'2026-09-08 11:48:38.617'`의 안쪽 값 -> `2026-09-08T11:48:38.617Z`. 형식이 다르면 예외. */
export function fromMysqlDatetime(value: string): string {
  if (!MYSQL_DATETIME.test(value)) throw new Error(`MySQL 시각 형식이 아닙니다: ${value}`);
  return `${value.slice(0, 10)}T${value.slice(11)}Z`;
}

/** 값 하나를 SQLite에 넣을 값으로 되돌린다. 시각 컬럼만 변환한다. */
export function toSqliteValue(column: string, value: SeedValue): SeedValue {
  if (value === null) return null;
  if (DATETIME_COLUMNS.has(column)) {
    if (typeof value !== "string") throw new Error(`시각 컬럼 ${column}이 문자열이 아닙니다`);
    return fromMysqlDatetime(value);
  }
  return value;
}

class Scanner {
  pos = 0;
  constructor(private readonly s: string) {}

  private skipSpace(): void {
    for (;;) {
      const ch = this.s[this.pos];
      if (ch === undefined) return;
      if (/\s/.test(ch)) this.pos++;
      else if (ch === "-" && this.s[this.pos + 1] === "-") {
        while (this.pos < this.s.length && this.s[this.pos] !== "\n") this.pos++;
      } else return;
    }
  }

  atEnd(): boolean {
    this.skipSpace();
    return this.pos >= this.s.length;
  }

  peek(): string | undefined {
    this.skipSpace();
    return this.s[this.pos];
  }

  expect(ch: string): void {
    this.skipSpace();
    if (this.s[this.pos] !== ch) throw new Error(`'${ch}'가 와야 하는데 위치 ${this.pos}에서 다른 문자가 나왔습니다`);
    this.pos++;
  }

  keyword(word: string): void {
    this.skipSpace();
    if (this.s.slice(this.pos, this.pos + word.length).toUpperCase() !== word) {
      throw new Error(`${word}가 와야 합니다 (위치 ${this.pos})`);
    }
    this.pos += word.length;
  }

  ident(): string {
    this.expect("`");
    const end = this.s.indexOf("`", this.pos);
    if (end < 0) throw new Error("닫히지 않은 식별자");
    const name = this.s.slice(this.pos, end);
    this.pos = end + 1;
    return name;
  }

  value(): SeedValue {
    this.skipSpace();
    const ch = this.s[this.pos];
    if (ch === "'") return this.string();
    if (this.s.slice(this.pos, this.pos + 4).toUpperCase() === "NULL") {
      this.pos += 4;
      return null;
    }
    const m = /^-?\d+/.exec(this.s.slice(this.pos, this.pos + 24));
    if (!m) throw new Error(`해석할 수 없는 값 (위치 ${this.pos})`);
    this.pos += m[0].length;
    const n = Number(m[0]);
    if (!Number.isSafeInteger(n)) throw new Error(`안전한 정수 범위를 넘습니다: ${m[0]}`);
    return n;
  }

  private string(): string {
    this.pos++; // 여는 따옴표
    let out = "";
    for (;;) {
      const ch = this.s[this.pos++];
      if (ch === undefined) throw new Error("닫히지 않은 문자열 리터럴");
      if (ch === "'") return out;
      if (ch !== "\\") {
        out += ch;
        continue;
      }
      const esc = this.s[this.pos++];
      switch (esc) {
        case "n":
          out += "\n";
          break;
        case "r":
          out += "\r";
          break;
        case "0":
          out += "\0";
          break;
        case "Z":
          out += "\x1a";
          break;
        case undefined:
          throw new Error("닫히지 않은 문자열 리터럴");
        default:
          out += esc; // \\ \' 그리고 MySQL처럼 알 수 없는 이스케이프는 문자 그대로
      }
    }
  }
}

/** 시드 SQL 텍스트를 INSERT 문 목록으로 읽는다(시각 변환 전의 원시 값). */
export function parseSeedSql(sql: string): SeedStatement[] {
  const sc = new Scanner(sql);
  const out: SeedStatement[] = [];
  while (!sc.atEnd()) {
    sc.keyword("INSERT");
    sc.keyword("INTO");
    const table = sc.ident();
    sc.expect("(");
    const columns = [sc.ident()];
    while (sc.peek() === ",") {
      sc.expect(",");
      columns.push(sc.ident());
    }
    sc.expect(")");
    sc.keyword("VALUES");
    const rows: SeedValue[][] = [];
    for (;;) {
      sc.expect("(");
      const row = [sc.value()];
      while (sc.peek() === ",") {
        sc.expect(",");
        row.push(sc.value());
      }
      sc.expect(")");
      if (row.length !== columns.length) throw new Error(`${table}: 열 ${columns.length}개인데 값이 ${row.length}개입니다`);
      rows.push(row);
      if (sc.peek() === ",") {
        sc.expect(",");
        continue;
      }
      break;
    }
    sc.expect(";");
    out.push({ table, columns, rows });
  }
  return out;
}

/** 시드 SQL 텍스트를 이미 스키마가 있는 DB에 적재한다. 적재한 행 수를 테이블별로 돌려준다. */
export function loadSeedSql(db: Database.Database, sql: string): Record<string, number> {
  const counts: Record<string, number> = {};
  const run = db.transaction(() => {
    for (const st of parseSeedSql(sql)) {
      const placeholders = st.columns.map(() => "?").join(", ");
      const insert = db.prepare(`INSERT INTO ${st.table} (${st.columns.join(", ")}) VALUES (${placeholders})`);
      for (const row of st.rows) {
        insert.run(...row.map((v, i) => toSqliteValue(st.columns[i], v)));
      }
      counts[st.table] = (counts[st.table] ?? 0) + st.rows.length;
    }
  });
  run();
  return counts;
}

/** `*.sql` 파일을 이름순(FK 순서)으로 읽어 새 SQLite 파일에 적재한다. */
export function seedToSqlite(dbPath: string, seedDir: string = DEFAULT_SEED_DIR): Record<string, number> {
  const db = openDatabase(dbPath);
  try {
    const counts: Record<string, number> = {};
    for (const f of readdirSync(seedDir).filter((n) => n.endsWith(".sql")).sort()) {
      const c = loadSeedSql(db, readFileSync(path.join(seedDir, f), "utf8"));
      for (const [t, n] of Object.entries(c)) counts[t] = (counts[t] ?? 0) + n;
    }
    // 이후 쓰기가 -wal에 남지 않게 한다(파일 복사본이 완전하도록).
    db.pragma("wal_checkpoint(TRUNCATE)");
    return counts;
  } finally {
    db.close();
  }
}
