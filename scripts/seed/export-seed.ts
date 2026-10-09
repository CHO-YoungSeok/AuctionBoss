/**
 * 시드 내보내기 (add-spring-mysql-backend D6).
 * data/auctionboss.db를 읽어 개인 이름을 가린 뒤 MySQL INSERT SQL을 backend/src/main/resources/db/seed/에 쓴다.
 *
 * 실행: npx tsx scripts/seed/export-seed.ts
 * 보고서에는 원래 이름을 적지 않는다(개수만). 남은 의심 문구는 가림 후 텍스트로만 보여 준다.
 */
import Database from "better-sqlite3";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { extractPersonNames, findSuspiciousPhrases, maskNames } from "./masking";
import { readColumns, TABLE_SPECS } from "./columns";
import { buildInserts, type SqlColumn } from "./sql";

const ROOT = path.resolve(__dirname, "../..");
// 재생성 검증용 덮어쓰기(기본값은 커밋된 시드 경로). 값은 경로뿐이다.
const DB_PATH = process.env.SEED_DB ?? path.join(ROOT, "data/auctionboss.db");
const OUT_DIR = process.env.SEED_OUT_DIR ?? path.join(ROOT, "backend/src/main/resources/db/seed");
const REPORT_PATH = process.env.SEED_REPORT ?? path.join(ROOT, "docs/untracked/seed-masking-report.md");
const COMMAND = "npx tsx scripts/seed/export-seed.ts";

/** FK 순서. 빈 테이블은 파일을 만들지 않는다. */
const SEED_FILES: Record<string, string> = {
  items: "01_items.sql",
  item_changes: "02_item_changes.sql",
  analyses: "03_analyses.sql",
  worker_runs: "04_worker_runs.sql",
  collector_state: "05_collector_state.sql",
};
const TABLES: { file: string; table: string; order: string }[] = TABLE_SPECS.filter((t) => t.table in SEED_FILES).map((t) => ({
  file: SEED_FILES[t.table],
  table: t.table,
  order: t.key,
}));

type Row = Record<string, unknown>;

function main(): void {
  const db = new Database(DB_PATH, { readonly: true });
  const sourceCounts: Record<string, number> = {};
  const data: Record<string, { columns: SqlColumn[]; rows: Row[] }> = {};

  for (const t of TABLES) {
    const columns = readColumns(db, t.table);
    const rows = db.prepare(`SELECT * FROM ${t.table} ORDER BY ${t.order}`).all() as Row[];
    sourceCounts[t.table] = rows.length;
    data[t.table] = { columns, rows };
  }
  db.close();

  // 1) 전체 이름 집합
  const names = new Set<string>();
  for (const r of data.items.rows) {
    if (typeof r.note === "string") for (const n of extractPersonNames(r.note)) names.add(n);
  }
  const nameList = [...names];

  // 2) note / body 가림
  let maskedNoteRows = 0;
  let maskedBodyRows = 0;
  for (const r of data.items.rows) {
    if (typeof r.note !== "string") continue;
    const masked = maskNames(r.note, nameList);
    if (masked !== r.note) maskedNoteRows++;
    r.note = masked;
  }
  for (const r of data.analyses.rows) {
    if (typeof r.body !== "string") continue;
    const masked = maskNames(r.body, nameList);
    if (masked !== r.body) maskedBodyRows++;
    r.body = masked;
  }

  // 3) 남은 의심 문구
  const suspicious: string[] = [];
  const scan = (label: string, id: unknown, text: unknown) => {
    if (typeof text !== "string") return;
    for (const phrase of findSuspiciousPhrases(text)) {
      const at = text.indexOf(phrase);
      const context = text.slice(Math.max(0, at - 15), at + phrase.length + 15).replace(/\s+/g, " ");
      suspicious.push(`${label} id=${String(id)}: "${phrase}" (문맥: ...${context}...)`);
    }
  };
  for (const r of data.items.rows) scan("items.note", r.id, r.note);
  for (const r of data.analyses.rows) scan("analyses.body", r.id, r.body);

  // 4) SQL 파일 쓰기
  mkdirSync(OUT_DIR, { recursive: true });
  for (const f of readdirSync(OUT_DIR)) if (f.endsWith(".sql")) rmSync(path.join(OUT_DIR, f));
  const exported: Record<string, number> = {};
  for (const t of TABLES) {
    const { columns, rows } = data[t.table];
    if (rows.length === 0) continue;
    const header =
      `-- 자동 생성 파일입니다. 직접 수정하지 마세요.\n` +
      `-- 생성 명령: ${COMMAND}\n` +
      `-- 원본: data/auctionboss.db, 테이블 ${t.table}, 원본 행 수 ${sourceCounts[t.table]}\n` +
      `-- 개인 이름은 scripts/seed/masking.ts 규칙으로 가림 처리됨\n\n`;
    writeFileSync(path.join(OUT_DIR, t.file), header + buildInserts(t.table, columns, rows).join("\n"), "utf8");
    exported[t.table] = rows.length;
  }

  // 5) 보고서
  const lines: string[] = [];
  lines.push("# 시드 가림 처리 보고서", "");
  lines.push(`- 생성 명령: \`${COMMAND}\``, "");
  lines.push("## 내보낸 행 수 (원본 행 수)");
  for (const t of TABLES) {
    lines.push(`- ${t.table}: ${exported[t.table] ?? "파일 없음(빈 테이블)"} (${sourceCounts[t.table]})`);
  }
  lines.push("", "## 가림 처리");
  lines.push(`- 가림 대상 이름 수: ${nameList.length}`);
  lines.push(`- 가림이 적용된 items.note 행 수: ${maskedNoteRows}`);
  lines.push(`- 가림이 적용된 analyses.body 행 수: ${maskedBodyRows}`);
  lines.push("", `## 가림 후 남은 의심 문구 (${suspicious.length}건)`);
  if (suspicious.length === 0) lines.push("- 없음");
  for (const s of suspicious) lines.push(`- ${s}`);
  const report = lines.join("\n") + "\n";

  mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  writeFileSync(REPORT_PATH, report, "utf8");
  process.stdout.write(report);
}

main();
