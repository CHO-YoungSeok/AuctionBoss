/**
 * 이전 뒤 API 동등성 비교 (migrate-data-and-cutover D6, tasks 4.1).
 *
 * 원본 쪽은 기존 Next 라우트 핸들러를 백업 SQLite(`AUCTIONBOSS_DB`)로 직접 호출하고, 대상 쪽은 이전된 MySQL에 붙은 Spring에
 * HTTP로 같은 요청을 보내 `ContractTest.diff`와 같은 엄격 비교를 한다(객체는 키 순서 무시, 배열은 길이·순서까지, 숫자는
 * 정수/실수 종류와 값).
 *
 * 요청 목록 = `scripts/seed/contract-specs.ts`(계약 골든 목록, 시각 의존 요청 제외) + 원본 모든 물건의 상세·변경 이력·
 * 분석 이력(`limit=50`)·사진 목록.
 *
 * 출력(D14): 요청 수, 불일치 수, 불일치한 요청 이름과 JSON 경로·사유 종류뿐이다. 값은 어떤 경로로도 출력하지 않는다
 * (전송 오류도 메시지 없이 "전송 실패"만).
 *
 * 실행: npx tsx scripts/migrate/compare-api.ts --source-db <백업.db> --spring-base <http://host:port>
 *   원본 SQLite는 핸들러가 스키마 확인을 위해 여는 연결이므로 "백업 복사본"을 넘겨야 한다. 운영 원본(`data/auctionboss.db`)
 *   경로는 거부한다. 외부 사이트에는 요청하지 않는다(대상은 인자로 받은 Spring 주소뿐).
 */
import Database from "better-sqlite3";
import { statSync } from "node:fs";
import path from "node:path";

import { buildSpecs } from "../seed/contract-specs";

export interface ApiResponse {
  status: number;
  /** JSON 본문. 본문이 JSON이 아니면 INVALID_JSON. */
  body: unknown;
}
export const INVALID_JSON = Symbol("invalid-json");

/** `/api/...?query` 형태의 요청 하나를 보내 응답을 돌려준다. 실패하면 던진다(메시지는 출력하지 않는다). */
export type ApiFetcher = (pathAndQuery: string) => Promise<ApiResponse>;

export interface NamedRequest {
  name: string;
  pathAndQuery: string;
}

export type DiffReason = "type" | "missing-key" | "extra-key" | "array-length" | "value" | "number" | "status" | "invalid-json" | "transport";

export interface Difference {
  path: string;
  reason: DiffReason;
}

/** 첫 번째 차이의 경로와 사유 종류. 같으면 null. 값은 담지 않는다. */
export function diffJson(expected: unknown, actual: unknown, at = "$"): Difference | null {
  if (expected === null || actual === null || typeof expected !== typeof actual) {
    return expected === actual ? null : { path: at, reason: "type" };
  }
  if (Array.isArray(expected) || Array.isArray(actual)) {
    if (!Array.isArray(expected) || !Array.isArray(actual)) return { path: at, reason: "type" };
    if (expected.length !== actual.length) return { path: at, reason: "array-length" };
    for (let i = 0; i < expected.length; i++) {
      const d = diffJson(expected[i], actual[i], `${at}[${i}]`);
      if (d) return d;
    }
    return null;
  }
  if (typeof expected === "object") {
    const e = expected as Record<string, unknown>;
    const a = actual as Record<string, unknown>;
    const keys = [...new Set([...Object.keys(e), ...Object.keys(a)])].sort();
    for (const key of keys) {
      const inE = Object.hasOwn(e, key);
      const inA = Object.hasOwn(a, key);
      if (inE !== inA) return { path: `${at}.${key}`, reason: inE ? "missing-key" : "extra-key" };
      const d = diffJson(e[key], a[key], `${at}.${key}`);
      if (d) return d;
    }
    return null;
  }
  if (typeof expected === "number") return expected === actual ? null : { path: at, reason: "number" };
  return expected === actual ? null : { path: at, reason: "value" };
}

export interface MismatchRecord extends Difference {
  name: string;
}

export interface CompareReport {
  requests: number;
  mismatches: number;
  mismatched: MismatchRecord[];
}

export async function compareRequests(
  requests: readonly NamedRequest[],
  source: ApiFetcher,
  target: ApiFetcher,
): Promise<CompareReport> {
  const mismatched: MismatchRecord[] = [];
  for (const req of requests) {
    let s: ApiResponse;
    try {
      s = await source(req.pathAndQuery);
    } catch {
      throw new Error(`원본 쪽 요청 실패: ${req.name}`); // 원본이 못 답하면 비교 자체가 무의미하다
    }
    let t: ApiResponse;
    try {
      t = await target(req.pathAndQuery);
    } catch {
      mismatched.push({ name: req.name, path: "$", reason: "transport" });
      continue;
    }
    if (s.status !== t.status) {
      mismatched.push({ name: req.name, path: "$", reason: "status" });
      continue;
    }
    if (s.body === INVALID_JSON || t.body === INVALID_JSON) {
      if (s.body !== t.body) mismatched.push({ name: req.name, path: "$", reason: "invalid-json" });
      continue;
    }
    const d = diffJson(s.body, t.body);
    if (d) mismatched.push({ name: req.name, ...d });
  }
  return { requests: requests.length, mismatches: mismatched.length, mismatched };
}

/** 요청 목록: 계약 골든 목록 + 원본 모든 물건의 상세·변경 이력·분석 이력·사진 목록. */
export function buildRequestList(sourceDb: string): NamedRequest[] {
  const db = new Database(sourceDb, { readonly: true, fileMustExist: true });
  let ids: number[];
  let total: number;
  try {
    ids = (db.prepare("SELECT id FROM items ORDER BY id").all() as { id: number }[]).map((r) => r.id);
    total = ids.length;
  } finally {
    db.close();
  }
  const list: NamedRequest[] = buildSpecs(total).map((s) => ({
    name: s.name,
    pathAndQuery: s.query ? `${s.path}?${s.query}` : s.path,
  }));
  for (const id of ids) {
    list.push({ name: `item-${id}-detail`, pathAndQuery: `/api/items/${id}` });
    list.push({ name: `item-${id}-changes`, pathAndQuery: `/api/items/${id}/changes` });
    list.push({ name: `item-${id}-analyses`, pathAndQuery: `/api/items/${id}/analyses?limit=50` });
    list.push({ name: `item-${id}-photos`, pathAndQuery: `/api/items/${id}/photos` });
  }
  return list;
}

/** 원본 쪽: Next 라우트 핸들러(GET)를 `sourceDb`로 직접 호출한다. */
export function createNextHandlerFetcher(sourceDb: string): ApiFetcher {
  const dbPath = path.resolve(sourceDb);
  return async (pathAndQuery) => {
    const previous = process.env.AUCTIONBOSS_DB;
    process.env.AUCTIONBOSS_DB = dbPath;
    const origError = console.error;
    console.error = () => undefined; // 500 로그에 값이 섞이지 않게
    try {
      const url = new URL(`http://localhost${pathAndQuery}`);
      const req = new Request(url);
      const p = (id: string) => Promise.resolve({ id });
      const pathname = url.pathname;
      let res: Response;
      let m: RegExpExecArray | null;
      if (pathname === "/api/items") res = (await import("../../src/app/api/items/route")).GET(req);
      else if (pathname === "/api/items/usage-types") res = (await import("../../src/app/api/items/usage-types/route")).GET();
      else if ((m = /^\/api\/items\/([^/]+)\/changes$/.exec(pathname)))
        res = await (await import("../../src/app/api/items/[id]/changes/route")).GET(req, { params: p(m[1]) });
      else if ((m = /^\/api\/items\/([^/]+)\/analyses$/.exec(pathname)))
        res = await (await import("../../src/app/api/items/[id]/analyses/route")).GET(req, { params: p(m[1]) });
      else if ((m = /^\/api\/items\/([^/]+)\/photos$/.exec(pathname)))
        res = await (await import("../../src/app/api/items/[id]/photos/route")).GET(req, { params: p(m[1]) });
      else if ((m = /^\/api\/items\/([^/]+)$/.exec(pathname)))
        res = await (await import("../../src/app/api/items/[id]/route")).GET(req, { params: p(m[1]) });
      else throw new Error("지원하지 않는 요청");
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        body = INVALID_JSON;
      }
      return { status: res.status, body };
    } finally {
      console.error = origError;
      if (previous === undefined) delete process.env.AUCTIONBOSS_DB;
      else process.env.AUCTIONBOSS_DB = previous;
    }
  };
}

/** 대상 쪽: Spring HTTP. 주소는 출력하지 않는다. */
export function createHttpFetcher(baseUrl: string, fetchImpl: typeof fetch = fetch, timeoutMs = 30_000): ApiFetcher {
  const base = baseUrl.replace(/\/+$/, "");
  return async (pathAndQuery) => {
    const res = await fetchImpl(`${base}${pathAndQuery}`, { signal: AbortSignal.timeout(timeoutMs) });
    const text = await res.text();
    try {
      return { status: res.status, body: JSON.parse(text) as unknown };
    } catch {
      return { status: res.status, body: INVALID_JSON };
    }
  };
}

export class CompareApiError extends Error {}

const LIVE_DEFAULT = path.resolve(__dirname, "../../data/auctionboss.db");

function sameFile(a: string, b: string): boolean {
  try {
    const sa = statSync(a);
    const sb = statSync(b);
    return sa.dev === sb.dev && sa.ino === sb.ino;
  } catch {
    return false;
  }
}

/** 경로 문자열뿐 아니라 심볼릭 링크·하드 링크로 같은 파일을 가리켜도(dev+ino 비교) 거부한다. */
export function assertNotLiveSource(sourceDb: string, live: string = LIVE_DEFAULT): void {
  const resolved = path.resolve(sourceDb);
  const targets = [live, `${live}-wal`, `${live}-shm`];
  if (targets.some((t) => resolved === t || sameFile(resolved, t))) {
    throw new CompareApiError("운영 원본 경로는 쓸 수 없습니다. 백업 복사본을 지정하세요.");
  }
}

const MAX_LISTED = 200;

export function formatReport(report: CompareReport): string {
  const lines = [`요청 ${report.requests}건, 불일치 ${report.mismatches}건`];
  for (const m of report.mismatched.slice(0, MAX_LISTED)) lines.push(`  불일치: ${m.name} ${m.path} (${m.reason})`);
  if (report.mismatched.length > MAX_LISTED) lines.push(`  ...외 ${report.mismatched.length - MAX_LISTED}건`);
  return lines.join("\n");
}

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

async function main(argv: string[]): Promise<number> {
  const sourceDb = arg(argv, "--source-db");
  const springBase = arg(argv, "--spring-base");
  if (!sourceDb || !springBase) {
    console.error("사용법: compare-api.ts --source-db <백업.db> --spring-base <http://host:port>");
    return 2;
  }
  assertNotLiveSource(sourceDb);
  const report = await compareRequests(buildRequestList(sourceDb), createNextHandlerFetcher(sourceDb), createHttpFetcher(springBase));
  const { closeDb } = await import("../../src/lib/db");
  closeDb();
  console.log(formatReport(report));
  return report.mismatches === 0 ? 0 : 1;
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e: unknown) => {
      console.error(e instanceof CompareApiError ? e.message : "compare-api 실패");
      process.exit(1);
    },
  );
}
