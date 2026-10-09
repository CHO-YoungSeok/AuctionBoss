/**
 * 운영 SQLite -> MySQL 이전용 내보내기 (migrate-data-and-cutover D2·D3·D8·D14).
 *
 * 실행: npx tsx scripts/migrate/export.ts [--source data/auctionboss.db] [--out data/migration/<UTC 시각>]
 *
 * 하는 일: (1) SQLite 백업 API로 스냅숏을 뜨고 그 파일만 읽는다. (2) 사전 조건을 확인한다. (3) 8개 테이블을
 * id 포함 INSERT SQL로 쓴다(시드 변환 `sql.ts` 재사용, 가림 없음). (4) 참조된 사진만 복사·해시한다.
 * (5) 정규화 해시·행 수·시퀀스를 매니페스트에 남긴다.
 *
 * 실명 보호: 결과물에는 실명이 있다. 출력은 `data/migration/<시각>/` 한 단계 아래만 허용하고, 표준 출력·오류에는
 * 테이블 이름, id, 컬럼 이름, 건수, 해시, 시간만 쓴다(값 금지).
 */
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { EXPECTED_COLUMNS, TABLE_SPECS, readColumns } from "../seed/columns";
import { buildInserts, toSqlValue, type SqlColumn } from "../seed/sql";
import { NORMALIZE_RULE_VERSION, NormalizeError, normalizeRow, tableDigest } from "./normalize";

const ROOT = path.resolve(__dirname, "../..");
export const DEFAULT_MIGRATION_ROOT = path.join(ROOT, "data/migration");

/** 값이 없는 내보내기 오류. 메시지는 이름·번호·건수만 담는다. */
export class ExportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExportError";
  }
}

export interface ExportOptions {
  /** 원본 SQLite 파일(읽기 전용으로만 연다). */
  sourceDb: string;
  /** 사진 원본 디렉터리. 기본값은 원본 DB 옆 `photos/`. */
  photosDir?: string;
  /** 출력 디렉터리. `migrationRoot` 바로 아래 한 단계여야 한다. 기본값은 `<migrationRoot>/<UTC 시각>`. */
  outDir?: string;
  /** 허용 출력 루트(기본 `data/migration`). 테스트가 임시 디렉터리로 바꾼다. */
  migrationRoot?: string;
  now?: () => Date;
  toolCommit?: string;
}

export interface TableManifest {
  file: string | null;
  rows: number;
  sha256: string;
  maxId: number | null;
  sqliteSeq: number | null;
  columns: string[];
}

export interface Manifest {
  ruleVersion: number;
  sourceSha256: string | null;
  exportedAt: string;
  toolCommit: string;
  tables: Record<string, TableManifest>;
  photos: { files: { path: string; size: number; sha256: string }[]; orphans: number };
}

export interface ExportResult {
  outDir: string;
  manifest: Manifest;
  seconds: number;
}

function sha256File(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/** `data/migration/<시각>/` 한 단계 아래만 허용한다. 심볼릭 링크로 밖을 가리켜도 거부한다. */
export function resolveOutDir(outDir: string | undefined, migrationRoot: string, now: Date): string {
  const rootReal = existsSync(migrationRoot) ? realpathSync(migrationRoot) : path.resolve(migrationRoot);
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const target = path.resolve(outDir ?? path.join(migrationRoot, stamp));
  const rel = path.relative(path.resolve(migrationRoot), target);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel) || rel.includes(path.sep)) {
    throw new ExportError("출력 경로는 data/migration/<시각>/ 바로 아래만 허용합니다");
  }
  if (existsSync(target)) {
    if (realpathSync(path.dirname(target)) !== rootReal) throw new ExportError("출력 경로가 허용 위치 밖을 가리킵니다");
    if (readdirSync(target).length > 0) throw new ExportError("출력 디렉터리가 이미 있고 비어 있지 않습니다");
  }
  return target;
}

function fileState(file: string): string {
  if (!existsSync(file)) return "none";
  const s = statSync(file);
  return `${s.size}:${s.mtimeMs}`;
}

function isSafeRelativePath(p: string): boolean {
  if (!p || path.isAbsolute(p) || p.includes("\0") || p.includes("\\")) return false;
  const norm = path.posix.normalize(p);
  return norm === p && !norm.startsWith("../") && norm !== "..";
}

function listFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else out.push(path.relative(dir, full).split(path.sep).join("/"));
    }
  };
  if (existsSync(dir)) walk(dir);
  return out.sort();
}

function gitCommit(): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "unknown";
  }
}

const FILE_NAMES = TABLE_SPECS.map((t, i) => ({ table: t.table, file: `${String(i + 1).padStart(2, "0")}_${t.table}.sql` }));

export async function runExport(opts: ExportOptions): Promise<ExportResult> {
  const started = Date.now();
  const now = (opts.now ?? (() => new Date()))();
  const migrationRoot = opts.migrationRoot ?? DEFAULT_MIGRATION_ROOT;
  const outDir = resolveOutDir(opts.outDir, migrationRoot, now);
  const photosSrc = opts.photosDir ?? path.join(path.dirname(path.resolve(opts.sourceDb)), "photos");
  if (!existsSync(opts.sourceDb)) throw new ExportError("원본 DB 파일이 없습니다");

  mkdirSync(outDir, { recursive: true });
  try {
    return await exportInto(opts, outDir, photosSrc, now, started);
  } catch (e) {
    rmSync(outDir, { recursive: true, force: true }); // 실패한 내보내기의 실명 데이터를 남기지 않는다.
    throw e;
  }
}

async function exportInto(opts: ExportOptions, outDir: string, photosSrc: string, now: Date, started: number): Promise<ExportResult> {
  // 1) 스냅숏. 백업 전후로 다른 쓰기가 없었는지 본다(data_version + 파일 상태).
  const snapshot = path.join(outDir, "source.db");
  const live = new Database(opts.sourceDb, { readonly: true });
  try {
    const fileStates = () => `${fileState(opts.sourceDb)}|${fileState(`${opts.sourceDb}-wal`)}`;
    const before = { v: live.pragma("data_version", { simple: true }), f: fileStates() };
    await live.backup(snapshot);
    const after = { v: live.pragma("data_version", { simple: true }), f: fileStates() };
    if (before.v !== after.v || before.f !== after.f) {
      throw new ExportError("백업 중에 원본 DB에 쓰기가 있었습니다. 쓰기 주체를 멈추고 다시 실행하세요");
    }
  } finally {
    live.close();
  }

  // 2) 이후에는 스냅숏만 읽는다.
  const db = new Database(snapshot, { readonly: true });
  try {
    const columnsByTable: Record<string, SqlColumn[]> = {};
    for (const spec of TABLE_SPECS) {
      const found = readColumns(db, spec.table);
      const expected = EXPECTED_COLUMNS[spec.table];
      const foundNames = found.map((c) => c.name);
      const missing = expected.filter((c) => !foundNames.includes(c));
      const extra = foundNames.filter((c) => !expected.includes(c));
      if (missing.length || extra.length) {
        throw new ExportError(`${spec.table}: 컬럼 집합이 다릅니다 (없음: ${missing.join(",") || "-"}, 더 있음: ${extra.join(",") || "-"})`);
      }
      // 이전 SQL과 해시는 MySQL 컬럼 순서를 쓴다.
      columnsByTable[spec.table] = expected.map((name) => found.find((c) => c.name === name)!);
    }

    const running = db
      .prepare(
        `SELECT worker FROM worker_runs w WHERE outcome = 'running'
           AND started_at = (SELECT MAX(started_at) FROM worker_runs WHERE worker = w.worker) GROUP BY worker`,
      )
      .all() as { worker: string }[];
    if (running.length > 0) {
      throw new ExportError(`최근 회차가 running인 워커가 있습니다: ${running.map((r) => r.worker).join(",")}. 회차가 끝난 뒤 다시 실행하세요`);
    }

    const seq = Object.fromEntries(
      (db.prepare("SELECT name, seq FROM sqlite_sequence").all() as { name: string; seq: number }[]).map((r) => [r.name, r.seq]),
    );

    // 3) 테이블별 SQL·해시
    const tables: Record<string, TableManifest> = {};
    let photoRows: { id: number; item_id: number; seq: number; file_path: string; file_size: number }[] = [];
    for (const spec of TABLE_SPECS) {
      const columns = columnsByTable[spec.table];
      const orderBy = spec.keyKind === "int" ? spec.key : `CAST("${spec.key}" AS BLOB)`; // 바이트 순
      const rows = db.prepare(`SELECT * FROM ${spec.table} ORDER BY ${orderBy}`).all() as Record<string, unknown>[];
      for (const row of rows) {
        const rowId = spec.keyKind === "int" ? `${spec.key}=${String(row[spec.key])}` : "행";
        for (const c of columns) {
          try {
            toSqlValue(row[c.name], c.kind);
            normalizeRow([c], row);
          } catch (e) {
            // 원래 메시지에는 값이 들어 있다. 테이블·id·컬럼·종류만 남긴다.
            const kind = e instanceof NormalizeError ? e.kind : c.kind;
            throw new ExportError(`${spec.table} ${rowId} 컬럼 ${c.name}: 형식이 올바르지 않습니다 (${kind})`);
          }
        }
      }
      const digest = tableDigest(spec.table, columns, rows);
      const file = FILE_NAMES.find((f) => f.table === spec.table)!.file;
      if (rows.length > 0) {
        const header = `-- 자동 생성 파일입니다. 직접 수정하지 마세요. (scripts/migrate/export.ts)\n-- 테이블 ${spec.table}, 행 수 ${rows.length}\n\n`;
        writeFileSync(path.join(outDir, file), header + buildInserts(spec.table, columns, rows).join("\n"), "utf8");
      }
      const maxId = rows.length > 0 && spec.keyKind === "int" ? Math.max(...rows.map((r) => r[spec.key] as number)) : null;
      tables[spec.table] = {
        file: rows.length > 0 ? file : null,
        rows: rows.length,
        sha256: digest.sha256,
        maxId,
        sqliteSeq: seq[spec.table] ?? null,
        columns: columns.map((c) => c.name),
      };
      if (spec.table === "item_photos") photoRows = rows as typeof photoRows;
    }

    // 4) 사진: 참조된 파일만 같은 상대 경로로 복사
    const photoFiles: Manifest["photos"]["files"] = [];
    const referenced = new Set<string>();
    for (const r of photoRows) {
      const where = `item_photos id=${r.id}`;
      if (!isSafeRelativePath(r.file_path)) throw new ExportError(`${where} 컬럼 file_path: 안전한 상대 경로가 아닙니다`);
      const src = path.join(photosSrc, r.file_path);
      if (!existsSync(src)) throw new ExportError(`${where}: 사진 파일이 없습니다`);
      const size = statSync(src).size;
      if (size !== r.file_size) throw new ExportError(`${where} 컬럼 file_size: 실제 파일 크기와 다릅니다`);
      if (referenced.has(r.file_path)) continue;
      referenced.add(r.file_path);
      const dest = path.join(outDir, "photos", r.file_path);
      mkdirSync(path.dirname(dest), { recursive: true });
      copyFileSync(src, dest);
      const sha = sha256File(dest);
      if (sha !== sha256File(src)) throw new ExportError(`${where}: 복사본 해시가 원본과 다릅니다`);
      photoFiles.push({ path: r.file_path, size, sha256: sha });
    }
    photoFiles.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const orphans = listFiles(photosSrc).filter((f) => !referenced.has(f)).length;

    const manifest: Manifest = {
      ruleVersion: NORMALIZE_RULE_VERSION,
      sourceSha256: sha256File(snapshot),
      exportedAt: now.toISOString(),
      toolCommit: opts.toolCommit ?? gitCommit(),
      tables,
      photos: { files: photoFiles, orphans },
    };
    writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");
    return { outDir, manifest, seconds: (Date.now() - started) / 1000 };
  } finally {
    db.close();
  }
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

if (require.main === module) {
  runExport({ sourceDb: path.resolve(arg("source") ?? path.join(ROOT, "data/auctionboss.db")), outDir: arg("out") })
    .then(({ outDir, manifest, seconds }) => {
      const out = [`출력: ${path.relative(ROOT, outDir)}`, `소요: ${seconds.toFixed(2)}초`, "테이블 행 수 해시"];
      for (const [t, m] of Object.entries(manifest.tables)) out.push(`  ${t} ${m.rows} ${m.sha256}`);
      out.push(`사진 파일 ${manifest.photos.files.length}개, 고아 ${manifest.photos.orphans}개`);
      process.stdout.write(out.join("\n") + "\n");
    })
    .catch((e: unknown) => {
      process.stderr.write(`내보내기 실패: ${e instanceof ExportError ? e.message : "예상하지 못한 오류"}\n`);
      process.exit(1);
    });
}
