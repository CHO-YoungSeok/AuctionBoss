import Database from "better-sqlite3";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDatabase } from "../../../src/lib/db/client";
import { buildInserts, type SqlColumn } from "../sql";
import {
  DATETIME_COLUMNS,
  DEFAULT_SEED_DIR,
  MYSQL_DATETIME,
  fromMysqlDatetime,
  loadSeedSql,
  parseSeedSql,
  seedToSqlite,
} from "../seed-to-sqlite";

let work: string;
beforeEach(() => {
  work = mkdtempSync(path.join(tmpdir(), "seed-to-sqlite-test-"));
});
afterEach(() => rmSync(work, { recursive: true, force: true }));

describe("parseSeedSql", () => {
  it("문자열 안의 세미콜론, 주석 표시, 괄호, 쉼표를 문법으로 보지 않는다", () => {
    const sql = `-- 주석 ; (
INSERT INTO \`t\` (\`a\`, \`b\`) VALUES
(1, 'x; -- y (z), w'),
(2, NULL);
`;
    expect(parseSeedSql(sql)).toEqual([{ table: "t", columns: ["a", "b"], rows: [[1, "x; -- y (z), w"], [2, null]] }]);
  });

  it("백슬래시 이스케이프를 되돌린다", () => {
    const sql = "INSERT INTO `t` (`a`) VALUES ('a\\'b\\\\c\\nd\\re\\0f\\Zg\\qh');";
    expect(parseSeedSql(sql)[0].rows[0][0]).toBe("a'b\\c\nd\re\0f\x1ag" + "qh");
  });

  it("열 수와 값 수가 다르면 예외", () => {
    expect(() => parseSeedSql("INSERT INTO `t` (`a`, `b`) VALUES (1);")).toThrow();
  });
});

describe("fromMysqlDatetime", () => {
  it("MySQL 시각을 ISO Z로 되돌린다", () => {
    expect(fromMysqlDatetime("2026-09-08 11:48:38.617")).toBe("2026-09-08T11:48:38.617Z");
  });
  it("형식이 다르면 예외", () => {
    expect(() => fromMysqlDatetime("2026-09-08T11:48:38.617Z")).toThrow();
  });
});

describe("왕복: 원본 행 -> SQL -> 역적재 -> 같은 행", () => {
  const columns: SqlColumn[] = [
    { name: "id", kind: "int" },
    { name: "court", kind: "text" },
    { name: "case_no", kind: "text" },
    { name: "item_no", kind: "text" },
    { name: "address", kind: "text" },
    { name: "note", kind: "text" },
    { name: "auction_date", kind: "date" },
    { name: "first_seen_at", kind: "datetime" },
    { name: "last_seen_at", kind: "datetime" },
    { name: "photo_collected_at", kind: "datetime" },
  ];
  const tricky = "홍'길\\동\n둘째줄\r셋째줄 \0 \x1a ; -- (a, b) `x` \"q\" 가나다";
  const rows = [
    {
      id: 1,
      court: "서울중앙지방법원",
      case_no: "2025타경1",
      item_no: "1",
      address: tricky,
      note: null,
      auction_date: "2026-10-13",
      first_seen_at: "2026-09-08T11:48:38.617Z",
      last_seen_at: "2026-10-01T18:57:20.009Z",
      photo_collected_at: null,
    },
    {
      id: 2,
      court: "c",
      case_no: "2025타경2",
      item_no: "2",
      address: "",
      note: "\\\\'",
      auction_date: null,
      first_seen_at: "2026-01-01T00:00:00.000Z",
      last_seen_at: "2026-01-01T00:00:00.000Z",
      photo_collected_at: "2026-02-03T04:05:06.007Z",
    },
  ];

  it("특수 문자와 시각이 그대로 돌아온다", () => {
    const sql = buildInserts("items", columns, rows).join("\n");
    const db = openDatabase(path.join(work, "a.db"));
    try {
      loadSeedSql(db, sql);
      const names = columns.map((c) => c.name).join(", ");
      expect(db.prepare(`SELECT ${names} FROM items ORDER BY id`).all()).toEqual(rows);
    } finally {
      db.close();
    }
  });

  it("시각이 시각 컬럼이 아니면 변환하지 않는다", () => {
    const sql = "INSERT INTO `items` (`id`, `court`, `case_no`, `item_no`, `address`, `note`, `first_seen_at`, `last_seen_at`) VALUES (1, 'c', 'n', '1', 'a', '2026-09-08 11:48:38.617', '2026-09-08 11:48:38.617', '2026-09-08 11:48:38.617');";
    const db = openDatabase(path.join(work, "b.db"));
    try {
      loadSeedSql(db, sql);
      const r = db.prepare("SELECT note, first_seen_at FROM items").get();
      expect(r).toEqual({ note: "2026-09-08 11:48:38.617", first_seen_at: "2026-09-08T11:48:38.617Z" });
    } finally {
      db.close();
    }
  });
});

describe("커밋된 시드 적재", () => {
  it("물건 809, 변경 이력 4008, 분석 12, 회차 7건이고 시각이 모두 ISO Z다", () => {
    const dbPath = path.join(work, "seed.db");
    const counts = seedToSqlite(dbPath);
    expect(counts).toMatchObject({ items: 809, item_changes: 4008, analyses: 12, worker_runs: 7, collector_state: 1 });

    const db = new Database(dbPath, { readonly: true });
    try {
      const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
      const checks: [string, string][] = [
        ["items", "first_seen_at"],
        ["items", "last_seen_at"],
        ["item_changes", "changed_at"],
        ["analyses", "analyzed_at"],
        ["worker_runs", "started_at"],
        ["worker_runs", "created_at"],
        ["collector_state", "updated_at"],
      ];
      for (const [t, c] of checks) {
        const vals = db.prepare(`SELECT ${c} AS v FROM ${t} WHERE ${c} IS NOT NULL`).all() as { v: string }[];
        expect(vals.length).toBeGreaterThan(0);
        expect(vals.every((r) => iso.test(r.v))).toBe(true);
      }
      // 명시 id로 적재했으므로 다음 id는 시드 최대 id + 1이다(시나리오 id 결정성).
      const seq = Object.fromEntries(
        (db.prepare("SELECT name, seq FROM sqlite_sequence").all() as { name: string; seq: number }[]).map((r) => [r.name, r.seq]),
      );
      expect(seq.analyses).toBe(12);
      expect(seq.worker_runs).toBe(7);
    } finally {
      db.close();
    }
  });

  it("MySQL 시각 모양의 값은 모두 시각 컬럼 안에만 있다(DATETIME_COLUMNS 누락 방지)", () => {
    for (const f of readdirSync(DEFAULT_SEED_DIR).filter((n) => n.endsWith(".sql"))) {
      for (const st of parseSeedSql(readFileSync(path.join(DEFAULT_SEED_DIR, f), "utf8"))) {
        st.columns.forEach((col, i) => {
          for (const row of st.rows) {
            const v = row[i];
            if (typeof v === "string" && MYSQL_DATETIME.test(v)) {
              expect(DATETIME_COLUMNS.has(col), `${st.table}.${col}`).toBe(true);
            }
          }
        });
      }
    }
  });
});
