import Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDatabase } from "../../../src/lib/db/client";
import { TABLE_SPECS, readColumns } from "../../seed/columns";
import { loadSeedSql, parseSeedSql } from "../../seed/seed-to-sqlite";
import { ExportError, runExport, type ExportOptions } from "../export";
import { buildSyntheticSource, SYNTHETIC_ORPHAN } from "../fixtures/synthetic-source";
import { tableDigest } from "../normalize";

const SENTINEL = "__REAL_NAME_SENTINEL__";
let work: string;
let root: string; // 허용 출력 루트(테스트용 data/migration 대신)
let src: ReturnType<typeof buildSyntheticSource>;

beforeEach(() => {
  work = mkdtempSync(path.join(tmpdir(), "migrate-export-"));
  root = path.join(work, "migration");
  mkdirSync(root);
  src = buildSyntheticSource(path.join(work, "src"));
});
afterEach(() => rmSync(work, { recursive: true, force: true }));

const base = (extra: Partial<ExportOptions> = {}): ExportOptions => ({
  sourceDb: src.dbPath,
  photosDir: src.photosDir,
  migrationRoot: root,
  now: () => new Date("2026-10-09T01:02:03.456Z"),
  toolCommit: "test",
  ...extra,
});

function sqlOf(outDir: string): string {
  return readdirSync(outDir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => readFileSync(path.join(outDir, f), "utf8"))
    .join("\n");
}

describe("runExport", () => {
  it("(a) 빈 번호 id와 sqlite_sequence가 매니페스트에 그대로 남는다", async () => {
    const { manifest, outDir } = await runExport(base());
    // 생성 SQL이 원본 id를 그대로 담는다(자동 번호가 아니다).
    const ids = (table: string) =>
      parseSeedSql(sqlOf(outDir))
        .filter((st) => st.table === table)
        .flatMap((st) => st.rows.map((r) => r[st.columns.indexOf("id")]));
    expect(ids("items")).toEqual([3, 7, 1200]);
    expect(ids("item_changes")).toEqual([2, 5, 9]);
    expect(ids("item_photos")).toEqual([3, 4, 10]);
    expect(manifest.tables.items).toMatchObject({ rows: 3, maxId: 1200, sqliteSeq: 5000 });
    expect(manifest.tables.item_changes).toMatchObject({ rows: 3, maxId: 9, sqliteSeq: 50 });
    expect(manifest.tables.worker_runs).toMatchObject({ rows: 3, maxId: 4, sqliteSeq: 4 });
    expect(manifest.tables.collector_state).toMatchObject({ rows: 5, maxId: null, sqliteSeq: null });
    expect(manifest.tables.bookmarks).toMatchObject({ rows: 1, maxId: 7 });
    expect(Object.keys(manifest.tables)).toEqual(TABLE_SPECS.map((t) => t.table));
  });

  it("(b) 생성 SQL을 되읽은 행이 원본과 같다(id 포함)", async () => {
    const { outDir, manifest } = await runExport(base());
    const back = openDatabase(path.join(work, "back.db"));
    try {
      loadSeedSql(back, sqlOf(outDir));
      const orig = new Database(src.dbPath, { readonly: true });
      try {
        for (const spec of TABLE_SPECS) {
          const cols = readColumns(back, spec.table);
          const a = orig.prepare(`SELECT * FROM ${spec.table}`).all() as Record<string, unknown>[];
          const b = back.prepare(`SELECT * FROM ${spec.table}`).all() as Record<string, unknown>[];
          expect(b.length).toBe(a.length);
          // 원본의 비표준 시각 표기는 ISO .SSSZ로 바뀌므로 정규화 해시로 같음을 본다.
          expect(tableDigest(spec.table, cols, b).sha256).toBe(manifest.tables[spec.table].sha256);
          expect(tableDigest(spec.table, cols, a).sha256).toBe(manifest.tables[spec.table].sha256);
        }
        // id와 큰 정수는 값 그대로다.
        expect(back.prepare("SELECT id, appraisal_price FROM items ORDER BY id").all()).toEqual(
          orig.prepare("SELECT id, appraisal_price FROM items ORDER BY id").all(),
        );
      } finally {
        orig.close();
      }
    } finally {
      back.close();
    }
  });

  it("(c) 최근 회차가 running이면 거부하고 출력을 남기지 않는다", async () => {
    const db = new Database(src.dbPath);
    db.prepare("INSERT INTO worker_runs (worker, started_at, outcome, created_at) VALUES ('collector', '2026-09-20T00:00:00.000Z', 'running', '2026-09-20T00:00:00.000Z')").run();
    db.close();
    await expect(runExport(base())).rejects.toThrow(/running/);
    expect(readdirSync(root)).toEqual([]);
  });

  it("(d) data/migration 밖 출력 경로를 거부한다", async () => {
    for (const bad of [path.join(work, "elsewhere"), path.join(root, "a", "b"), path.join(root, "..", "x"), root]) {
      await expect(runExport(base({ outDir: bad }))).rejects.toThrow(ExportError);
    }
    expect(existsSync(path.join(work, "elsewhere"))).toBe(false);
    // 허용 위치(루트 바로 아래)는 통과한다.
    await expect(runExport(base({ outDir: path.join(root, "20261009T010203Z") }))).resolves.toBeDefined();
  });

  it("(e) 형식이 다른 시각 행은 테이블·id·컬럼 이름으로 실패하고 값은 출력에 없다", async () => {
    const db = new Database(src.dbPath);
    db.prepare("UPDATE items SET last_seen_at = ? WHERE id = 7").run(SENTINEL);
    db.close();
    let msg = "";
    try {
      await runExport(base());
    } catch (e) {
      msg = String((e as Error).message);
    }
    expect(msg).toContain("items");
    expect(msg).toContain("id=7");
    expect(msg).toContain("last_seen_at");
    expect(msg).not.toContain(SENTINEL);
    expect(readdirSync(root)).toEqual([]);
  });

  it("(e2) 정수 컬럼의 비정수 값과 깨진 JSON도 값 없이 실패한다", async () => {
    for (const [sql, col] of [
      [`UPDATE items SET failed_bid_count = '${SENTINEL}' WHERE id = 3`, "failed_bid_count"],
      [`UPDATE worker_runs SET detail = '{"a": ${SENTINEL}' WHERE id = 1`, "detail"],
      [`UPDATE items SET auction_date = '${SENTINEL}' WHERE id = 3`, "auction_date"],
    ] as const) {
      const fresh = buildSyntheticSource(path.join(work, `s-${col}`));
      const db = new Database(fresh.dbPath);
      db.exec(sql);
      db.close();
      let msg = "";
      try {
        await runExport({ ...base(), sourceDb: fresh.dbPath, photosDir: fresh.photosDir });
      } catch (e) {
        msg = String((e as Error).message);
      }
      expect(msg, col).toContain(col);
      expect(msg, col).not.toContain(SENTINEL);
    }
  });

  it("(f) 고아 사진 파일은 복사하지 않고 건수 1로 남긴다", async () => {
    const { outDir, manifest } = await runExport(base());
    expect(manifest.photos.orphans).toBe(1);
    expect(manifest.photos.files.map((f) => f.path)).toEqual(["1200/1.jpg", "7/1.jpg", "7/2.png"]);
    expect(existsSync(path.join(outDir, "photos", SYNTHETIC_ORPHAN))).toBe(false);
    expect(existsSync(path.join(outDir, "photos", "7/1.jpg"))).toBe(true);
  });

  it("(g) 두 번 실행한 SQL과 매니페스트(시각 필드 제외)가 바이트 단위로 같다", async () => {
    const a = await runExport(base({ outDir: path.join(root, "r1") }));
    const b = await runExport(base({ outDir: path.join(root, "r2") }));
    const strip = (m: typeof a.manifest) => JSON.stringify({ ...m, exportedAt: null, sourceSha256: null }, null, 2);
    expect(strip(b.manifest)).toBe(strip(a.manifest));
    expect(sqlOf(b.outDir)).toBe(sqlOf(a.outDir));
    expect(a.manifest.sourceSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("사진 파일이 없거나 크기가 다르거나 경로가 안전하지 않으면 실패한다", async () => {
    const db = new Database(src.dbPath);
    db.prepare("UPDATE item_photos SET file_path = '../x.jpg' WHERE id = 3").run();
    db.close();
    await expect(runExport(base())).rejects.toThrow(/file_path/);
    expect(readdirSync(root)).toEqual([]);
  });

  it("컬럼 집합이 다르면 컬럼 이름으로 실패한다", async () => {
    const db = new Database(src.dbPath);
    db.exec("ALTER TABLE items ADD COLUMN surprise_col TEXT");
    db.close();
    await expect(runExport(base())).rejects.toThrow(/items.*surprise_col/);
  });

  it("원본 파일을 바꾸지 않는다(읽기 전용)", async () => {
    const before = readFileSync(src.dbPath);
    await runExport(base());
    expect(readFileSync(src.dbPath).equals(before)).toBe(true);
  });
});
