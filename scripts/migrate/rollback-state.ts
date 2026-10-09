/**
 * 롤백 상태 되쓰기 (migrate-data-and-cutover D11, tasks 4.3).
 *
 * 백엔드 1회 실행 모드 `export-state`가 낸 한 줄 JSON(`{"backoffUntil":"…Z"|null,"rotationNextCourtCode":"…"|null}`)을 받아
 * 롤백 대상 SQLite의 `collector_state`에 쓴다.
 *  - 백오프: MySQL 값이 SQLite 값보다 **늦을 때만** 쓴다(TS `collector-state.ts`의 `extendBackoffUntil`, "짧아지지 않음"). 이르거나
 *    같으면 SQLite 값을 유지하고, MySQL에 값이 없으면(null) 건드리지 않는다.
 *  - 로테이션 위치: MySQL 값이 있으면 항상 덮어쓴다. MySQL에 값이 없으면(null) SQLite 값을 그대로 둔다(덮어쓸 값이 없다).
 *
 * 이 도구가 SQLite에 쓰는 유일한 경로다(그 밖의 이전 도구는 원본을 읽기만 한다). 그래서 대상 경로를 반드시 명시 인자로 받고
 * `data/auctionboss.db` 같은 기본값을 쓰지 않으며, 파일이 이미 있어야 한다(없으면 새 DB를 만들지 않고 실패한다).
 * 출력에는 결과 종류만 쓴다(오류 메시지에도 입력 값을 넣지 않는다).
 *
 * 실행: npx tsx scripts/migrate/rollback-state.ts --sqlite <롤백 대상.db> --state <export-state 출력 파일 | ->
 */
import { existsSync, readFileSync } from "node:fs";

import { createCollectorStateRepository, COLLECTOR_STATE_KEYS } from "../../src/lib/db/collector-state";
import { openDatabase, type Db } from "../../src/lib/db/client";

export class RollbackStateError extends Error {}

export interface ExportedState {
  backoffUntil: string | null;
  rotationNextCourtCode: string | null;
}

/** export-state 출력에서 JSON 한 줄을 읽는다(앞뒤에 로그 줄이 섞여 있어도 마지막 `{`로 시작하는 줄). */
export function parseExportedState(text: string): ExportedState {
  const line = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith("{"))
    .at(-1);
  if (!line) throw new RollbackStateError("export-state 출력에서 JSON 줄을 찾지 못했습니다.");
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    throw new RollbackStateError("export-state 출력이 JSON이 아닙니다.");
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new RollbackStateError("export-state 출력 형식이 다릅니다.");
  const o = raw as Record<string, unknown>;
  const keys = Object.keys(o).sort().join(",");
  if (keys !== "backoffUntil,rotationNextCourtCode") throw new RollbackStateError("export-state 출력의 키가 다릅니다.");
  const { backoffUntil, rotationNextCourtCode } = o;
  if (backoffUntil !== null && (typeof backoffUntil !== "string" || Number.isNaN(new Date(backoffUntil).getTime())))
    throw new RollbackStateError("backoffUntil이 시각이 아닙니다.");
  if (rotationNextCourtCode !== null && (typeof rotationNextCourtCode !== "string" || rotationNextCourtCode === ""))
    throw new RollbackStateError("rotationNextCourtCode가 문자열이 아닙니다.");
  return { backoffUntil, rotationNextCourtCode } as ExportedState;
}

export interface RollbackResult {
  backoff: "written" | "kept" | "absent";
  rotation: "written" | "absent";
}

export function applyRollbackState(db: Db, state: ExportedState, options: { now?: string } = {}): RollbackResult {
  const repo = createCollectorStateRepository(db);
  const result: RollbackResult = { backoff: "absent", rotation: "absent" };

  if (state.backoffUntil !== null) {
    const incoming = new Date(state.backoffUntil);
    const before = repo.getBackoffUntil();
    repo.extendBackoffUntil(incoming, options);
    const after = repo.getBackoffUntil();
    result.backoff = !before || after!.getTime() !== before.getTime() ? "written" : "kept";
  }
  if (state.rotationNextCourtCode !== null) {
    repo.setCollectorState(COLLECTOR_STATE_KEYS.ROTATION_NEXT_COURT_CODE, state.rotationNextCourtCode, options);
    result.rotation = "written";
  }
  return result;
}

export function rollbackState(sqlitePath: string, stateText: string, options: { now?: string } = {}): RollbackResult {
  if (!sqlitePath) throw new RollbackStateError("--sqlite(롤백 대상 SQLite 경로)가 필요합니다.");
  if (!existsSync(sqlitePath)) throw new RollbackStateError("롤백 대상 SQLite 파일이 없습니다. 새 DB를 만들지 않습니다.");
  const state = parseExportedState(stateText);
  const db = openDatabase(sqlitePath);
  try {
    return applyRollbackState(db, state, options);
  } finally {
    db.close();
  }
}

export function formatResult(r: RollbackResult): string {
  const b = { written: "기록(MySQL 값이 더 늦음)", kept: "유지(SQLite 값이 같거나 더 늦음)", absent: "없음(건드리지 않음)" }[r.backoff];
  const t = { written: "기록(덮어씀)", absent: "없음(건드리지 않음)" }[r.rotation];
  return `백오프: ${b}\n로테이션: ${t}`;
}

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

if (require.main === module) {
  try {
    const sqlite = arg(process.argv, "--sqlite");
    const statePath = arg(process.argv, "--state");
    if (!sqlite || !statePath) {
      console.error("사용법: rollback-state.ts --sqlite <롤백 대상.db> --state <export-state 출력 파일 | ->");
      process.exit(2);
    }
    const text = readFileSync(statePath === "-" ? 0 : statePath, "utf8");
    console.log(formatResult(rollbackState(sqlite, text)));
  } catch (e) {
    console.error(e instanceof RollbackStateError ? e.message : "rollback-state 실패");
    process.exit(1);
  }
}
