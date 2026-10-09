/**
 * 교차 언어 골든 생성 (migrate-data-and-cutover D4).
 * 합성 SQLite 원본을 내보내기 도구로 내보내 `backend/src/test/resources/migration/`에 쓴다:
 * `sql/*.sql`, `manifest.json`, `photos/**`. Java 테스트가 같은 SQL을 MySQL에 적재해 같은 해시가 나오는지 본다.
 *
 * 실행: npx tsx scripts/migrate/generate-migration-golden.ts
 * 시각·커밋·백업 해시처럼 실행마다 달라질 수 있는 필드는 고정값으로 쓴다(바이트 단위 재현).
 */
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { runExport, type Manifest } from "./export";
import { buildSyntheticSource } from "./fixtures/synthetic-source";

export const GOLDEN_DIR = path.resolve(__dirname, "../../backend/src/test/resources/migration");

/** `destDir`를 비우고 골든을 쓴다. */
export async function generateGolden(destDir: string): Promise<Manifest> {
  const work = mkdtempSync(path.join(tmpdir(), "migration-golden-"));
  try {
    const src = buildSyntheticSource(path.join(work, "src"));
    const root = path.join(work, "migration");
    mkdirSync(root);
    const { outDir, manifest } = await runExport({
      sourceDb: src.dbPath,
      photosDir: src.photosDir,
      migrationRoot: root,
      outDir: path.join(root, "golden"),
      now: () => new Date("2026-01-01T00:00:00.000Z"),
      toolCommit: "golden",
    });
    const golden: Manifest = { ...manifest, sourceSha256: null };
    rmSync(destDir, { recursive: true, force: true });
    mkdirSync(path.join(destDir, "sql"), { recursive: true });
    for (const f of readdirSync(outDir).filter((n) => n.endsWith(".sql"))) {
      cpSync(path.join(outDir, f), path.join(destDir, "sql", f));
    }
    cpSync(path.join(outDir, "photos"), path.join(destDir, "photos"), { recursive: true });
    writeFileSync(path.join(destDir, "manifest.json"), JSON.stringify(golden, null, 2) + "\n", "utf8");
    return golden;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

export function readTree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else out[path.relative(dir, full).split(path.sep).join("/")] = readFileSync(full).toString("base64");
    }
  };
  walk(dir);
  return out;
}

if (require.main === module) {
  generateGolden(GOLDEN_DIR).then((m) => {
    process.stdout.write(`골든 생성: ${path.relative(process.cwd(), GOLDEN_DIR)} (테이블 ${Object.keys(m.tables).length}개)\n`);
  });
}
