/**
 * 실제 사이트 확인(8.4) 보조: 읽기 전용 비교·사전 확인 (port-collector-to-spring D13, tasks 8.3).
 *
 * 외부 요청을 하지 않고, 어떤 DB에도 쓰지 않는다(SQLite는 readonly로 연다). 출력은 건수와 컬럼 이름뿐이다(값·개인 정보 없음).
 *
 *   print-sql                                    확인용 MySQL에서 비교 컬럼을 JSON 한 줄씩 뽑는 SELECT를 출력한다.
 *   preflight --sqlite <db> [--gap-minutes 15] [--now <ISO>]
 *                                                TS 워커가 멈춘 창인지 SQLite로 확인한다. 하나라도 어긋나면 종료 코드 1.
 *   compare --spring-ndjson <파일> --sqlite <db> 자연 키(법원, 사건번호, 물건번호)로 같은 물건을 맞춰 정규화 컬럼을 비교한다.
 *                                                불일치 물건이 있으면 종료 코드 1.
 *
 * 실행: npx tsx scripts/collector-golden/compare-live.ts <하위 명령> ...
 *
 * 비교에서 빼는 컬럼: id(저장 순서), first_seen_at·last_seen_at(시각), photo_*(사진 워커 상태이며 소스 값이 아니다).
 * 값 비교는 null과 값을 구별하고, 숫자와 숫자꼴 문자열은 같게 본다(SQLite는 동적 타입, MySQL은 JSON 숫자).
 */
import { readFileSync } from "node:fs";

import Database from "better-sqlite3";

export const NATURAL_KEY = ["court", "case_no", "item_no"] as const;

/** 정규화 비교 컬럼(시각·id·사진 상태 제외). V1 스키마의 소스 유래 컬럼 전부. */
export const COMPARED_COLUMNS = [
  "address", "usage_type", "appraisal_price", "min_bid_price", "auction_date", "failed_bid_count", "status",
  "min_area", "max_area", "building_description",
  "min_bid_price_round1", "min_bid_price_round2", "min_bid_price_round3", "min_bid_price_round4",
  "min_bid_price_rate_round1", "min_bid_price_rate_round2",
  "usage_code_large", "usage_code_medium", "usage_code_small",
  "sido", "sigungu", "dong", "lot_number", "building_name", "building_unit",
  "coordinate_x", "coordinate_y", "coordinate_level",
  "auction_time", "auction_place", "auction_decision_date", "auction_round",
  "note", "duplicate_case_no", "merged_case_no", "court_department", "court_phone",
  "status_code", "item_status_code", "internal_case_no", "court_code",
] as const;

type Row = Record<string, unknown>;

export interface CompareResult {
  springRows: number;
  sqliteRows: number;
  duplicateKeysInSpring: number;
  matched: number;
  onlyInSpring: number;
  mismatchedItems: number;
  mismatchedCells: number;
  byColumn: Record<string, number>;
}

export function printSql(): string {
  const pairs = [...NATURAL_KEY, ...COMPARED_COLUMNS].map((c) => `'${c}', ${c}`).join(", ");
  return `SELECT JSON_OBJECT(${pairs}) FROM items ORDER BY id`;
}

function norm(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return String(value);
}

function keyOf(row: Row): string {
  return JSON.stringify(NATURAL_KEY.map((k) => norm(row[k])));
}

export function compareItems(springRows: readonly Row[], sqliteRows: readonly Row[]): CompareResult {
  const sqliteByKey = new Map<string, Row>();
  for (const r of sqliteRows) sqliteByKey.set(keyOf(r), r);

  const seen = new Set<string>();
  const result: CompareResult = {
    springRows: springRows.length,
    sqliteRows: sqliteRows.length,
    duplicateKeysInSpring: 0,
    matched: 0,
    onlyInSpring: 0,
    mismatchedItems: 0,
    mismatchedCells: 0,
    byColumn: {},
  };
  for (const row of springRows) {
    const key = keyOf(row);
    if (seen.has(key)) {
      result.duplicateKeysInSpring += 1;
      continue;
    }
    seen.add(key);
    const other = sqliteByKey.get(key);
    if (!other) {
      result.onlyInSpring += 1;
      continue;
    }
    result.matched += 1;
    let differing = 0;
    for (const col of COMPARED_COLUMNS) {
      if (norm(row[col]) !== norm(other[col])) {
        differing += 1;
        result.byColumn[col] = (result.byColumn[col] ?? 0) + 1;
      }
    }
    if (differing > 0) {
      result.mismatchedItems += 1;
      result.mismatchedCells += differing;
    }
  }
  return result;
}

export interface PreflightInput {
  now: Date;
  gapMinutes: number;
  /** collector_state의 backoff_until 원문(없으면 null). */
  backoffUntil: string | null;
  /** collector·photos 회차 중 건너뜀이 아닌 것들. */
  runs: { worker: string; outcome: string; startedAt: string; finishedAt: string | null }[];
}

export interface PreflightResult {
  ok: boolean;
  /** 사람이 읽는 확인 결과 한 줄씩(값 없이 사실만). */
  lines: string[];
}

/** 진행 중으로 남은 회차를 "실제 진행 중"으로 볼 최대 나이. 더 오래된 running 행은 비정상 종료 흔적으로 보고 알리기만 한다. */
const RUNNING_FRESH_MINUTES = 30;

export function evaluatePreflight(input: PreflightInput): PreflightResult {
  const lines: string[] = [];
  let ok = true;
  const fail = (msg: string) => { ok = false; lines.push(`실패: ${msg}`); };
  const pass = (msg: string) => lines.push(`통과: ${msg}`);

  if (input.backoffUntil === null || input.backoffUntil === "") {
    pass("백오프 기록 없음");
  } else {
    const until = new Date(input.backoffUntil);
    if (Number.isNaN(until.getTime())) fail("backoff_until을 해석할 수 없음");
    else if (until.getTime() > input.now.getTime()) {
      fail(`백오프가 아직 남음(${Math.ceil((until.getTime() - input.now.getTime()) / 60000)}분)`);
    } else pass("백오프 만료됨");
  }

  let freshRunning = 0;
  let staleRunning = 0;
  let latestMs: number | null = null;
  for (const run of input.runs) {
    const started = new Date(run.startedAt).getTime();
    if (run.finishedAt === null && run.outcome === "running") {
      if (input.now.getTime() - started < RUNNING_FRESH_MINUTES * 60000) freshRunning += 1;
      else staleRunning += 1;
      continue;
    }
    const ended = new Date(run.finishedAt ?? run.startedAt).getTime();
    if (!Number.isNaN(ended) && (latestMs === null || ended > latestMs)) latestMs = ended;
  }
  if (freshRunning > 0) fail(`진행 중인 TS 회차 ${freshRunning}건(최근 ${RUNNING_FRESH_MINUTES}분 안에 시작)`);
  else pass("진행 중인 TS 회차 없음");
  if (staleRunning > 0) lines.push(`참고: ${RUNNING_FRESH_MINUTES}분보다 오래된 running 행 ${staleRunning}건(비정상 종료 흔적으로 보고 무시)`);

  if (latestMs === null) pass("TS 회차 기록 없음");
  else {
    const gap = (input.now.getTime() - latestMs) / 60000;
    if (gap < input.gapMinutes) fail(`직전 TS 회차가 끝난 지 ${Math.floor(gap)}분(기준 ${input.gapMinutes}분 이상)`);
    else pass(`직전 TS 회차 이후 ${Math.floor(gap)}분 경과(기준 ${input.gapMinutes}분)`);
  }
  return { ok, lines };
}

function openReadonly(dbPath: string): Database.Database {
  return new Database(dbPath, { readonly: true, fileMustExist: true });
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

function main(argv: string[]): number {
  const [cmd, ...args] = argv;
  if (cmd === "print-sql") {
    console.log(printSql());
    return 0;
  }
  const sqlitePath = flag(args, "sqlite");
  if (cmd === "preflight") {
    if (!sqlitePath) { console.error("--sqlite이 필요합니다"); return 2; }
    const db = openReadonly(sqlitePath);
    try {
      const backoff = db.prepare("SELECT value FROM collector_state WHERE key = 'backoff_until'").get() as { value: string } | undefined;
      const runs = (db
        .prepare("SELECT worker, outcome, started_at, finished_at FROM worker_runs WHERE worker IN ('collector','photos') AND outcome != 'skipped'")
        .all() as { worker: string; outcome: string; started_at: string; finished_at: string | null }[])
        .map((r) => ({ worker: r.worker, outcome: r.outcome, startedAt: r.started_at, finishedAt: r.finished_at }));
      const now = flag(args, "now") ? new Date(flag(args, "now")!) : new Date();
      const result = evaluatePreflight({ now, gapMinutes: Number(flag(args, "gap-minutes") ?? "15"), backoffUntil: backoff?.value ?? null, runs });
      for (const l of result.lines) console.log(l);
      return result.ok ? 0 : 1;
    } finally {
      db.close();
    }
  }
  if (cmd === "compare") {
    const ndjson = flag(args, "spring-ndjson");
    if (!sqlitePath || !ndjson) { console.error("--sqlite과 --spring-ndjson이 필요합니다"); return 2; }
    const springRows = readFileSync(ndjson, "utf8").split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l) as Row);
    const db = openReadonly(sqlitePath);
    let sqliteRows: Row[];
    try {
      sqliteRows = db.prepare(`SELECT ${[...NATURAL_KEY, ...COMPARED_COLUMNS].join(", ")} FROM items`).all() as Row[];
    } finally {
      db.close();
    }
    const r = compareItems(springRows, sqliteRows);
    console.log(`확인용 DB 물건 ${r.springRows}건, TS SQLite 물건 ${r.sqliteRows}건`);
    console.log(`자연 키 중복(확인용 DB) ${r.duplicateKeysInSpring}건`);
    console.log(`같은 물건 ${r.matched}건, TS SQLite에 없는 물건 ${r.onlyInSpring}건`);
    console.log(`비교 불일치: 물건 ${r.mismatchedItems}건, 칸 ${r.mismatchedCells}개`);
    for (const [col, n] of Object.entries(r.byColumn)) console.log(`  불일치 컬럼 ${col}: ${n}건`);
    if (r.matched === 0) console.log("주의: 맞춰 볼 수 있는 물건이 0건이라 비교가 비어 있습니다");
    return r.mismatchedItems > 0 || r.duplicateKeysInSpring > 0 ? 1 : 0;
  }
  console.error("사용법: compare-live.ts print-sql | preflight --sqlite <db> | compare --spring-ndjson <파일> --sqlite <db>");
  return 2;
}

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}
