import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { openDatabase } from "../../../src/lib/db/client";
import { DATETIME_COLUMNS, EXPECTED_COLUMNS, TABLE_SPECS, readColumns } from "../columns";

const MIGRATION_DIR = path.resolve(__dirname, "../../../backend/src/main/resources/db/migration");

/** V1의 CREATE TABLE 컬럼 순서 + V2에서 추가한 컬럼. */
function mysqlColumns(): Record<string, string[]> {
  const v1 = readFileSync(path.join(MIGRATION_DIR, "V1__baseline.sql"), "utf8").replace(/--.*$/gm, "");
  const out: Record<string, string[]> = {};
  for (const m of v1.matchAll(/CREATE TABLE (\w+) \(([\s\S]*?)\n\) ENGINE/g)) {
    out[m[1]] = m[2]
      .split("\n")
      .map((l) => /^\s*`?(\w+)`?\s+(?:VARCHAR|BIGINT|INT|TEXT|DATETIME|DATE|JSON)/.exec(l)?.[1])
      .filter((c): c is string => !!c);
  }
  const v2 = readFileSync(path.join(MIGRATION_DIR, "V2__item_photo_attempt.sql"), "utf8");
  for (const m of v2.matchAll(/ALTER TABLE (\w+) ADD COLUMN (\w+)/g)) out[m[1]].push(m[2]);
  return out;
}

describe("EXPECTED_COLUMNS", () => {
  it("Flyway V1~V2의 MySQL 컬럼 순서와 같다", () => {
    expect(EXPECTED_COLUMNS).toEqual(mysqlColumns());
  });

  it("schema.ts로 만든 SQLite의 컬럼 집합과 같다", () => {
    const db = openDatabase(":memory:");
    try {
      for (const spec of TABLE_SPECS) {
        expect(readColumns(db, spec.table).map((c) => c.name).sort()).toEqual([...EXPECTED_COLUMNS[spec.table]].sort());
      }
    } finally {
      db.close();
    }
  });

  it("MySQL의 DATETIME 컬럼은 모두 시각 컬럼으로 판정된다", () => {
    const v1 = readFileSync(path.join(MIGRATION_DIR, "V1__baseline.sql"), "utf8");
    const names = [...v1.matchAll(/^\s*`?(\w+)`?\s+DATETIME\(3\)/gm)].map((m) => m[1]);
    expect(names.length).toBeGreaterThan(10);
    for (const n of [...names, "photo_attempted_at"]) expect(DATETIME_COLUMNS.has(n), n).toBe(true);
  });
});
