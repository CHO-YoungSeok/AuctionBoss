/**
 * 시나리오 골든 생성 (add-spring-write-api 1장, D10).
 *
 * 커밋된 시드 SQL을 임시 SQLite에 적재(seed-to-sqlite.ts)하고, 시나리오마다 그 복사본에서 시작해
 * 기존 Next 라우트 핸들러를 단계 순서대로 직접 호출한다. 응답을
 * backend/src/test/resources/contracts/scenarios/{이름}.json 으로 저장한다.
 * 운영 DB(data/auctionboss.db)는 읽지 않는다.
 *
 * 골든 형식:
 *   { clock: { start, stepMs }, config, photos?, steps: [{ request, status, body | text | photo, capture? }] }
 *   - 단계 i(0부터)의 서버 시각은 start + i * stepMs. 생성 중 전역 Date를 그 값으로 고정한다.
 *   - request: { method, path, query, body? | rawBody? }. path의 `{변수}`는 앞 단계 capture로 치환한다.
 *   - capture: { 변수: "$.경로" }. 응답 본문에서 뽑은 값(숫자/문자열)을 변수로 둔다.
 *   - photo: { contentType, cacheControl, sha256 } (사진 200 응답).
 *   - photos: 사진 디렉터리에 준비할 item_photos 행과 픽스처 파일.
 *
 * 실행: npx tsx scripts/seed/generate-scenarios.ts
 */
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { withFixedNow } from "./fixed-clock";
import { CLOCK, SCENARIOS, type ScenarioDef } from "./scenarios";
import { seedToSqlite } from "./seed-to-sqlite";
import { extractPersonNames } from "./masking";

const ROOT = path.resolve(__dirname, "../..");
export const CONTRACTS_DIR = path.join(ROOT, "backend/src/test/resources/contracts");
export const SCENARIOS_DIR = path.join(CONTRACTS_DIR, "scenarios");
export const PHOTO_FIXTURE_DIR = path.join(CONTRACTS_DIR, "photos");
const COLLECTOR_CONFIG = path.join(ROOT, "config/collector.json");

/** 고정 시계로 잡히지 않는 시각 값의 표식. 목표는 0개다. */
export const ISO_MS_MARKER = "<iso-ms>";

type Json = unknown;

export interface GoldenStep {
  request: { method: string; path: string; query: string; body?: Json; rawBody?: string };
  status: number;
  body?: Json;
  text?: string;
  photo?: { contentType: string | null; cacheControl: string | null; sha256: string };
  capture?: Record<string, string>;
}

export interface Golden {
  clock: { start: string; stepMs: number };
  config: ScenarioDef["config"];
  photos?: ScenarioDef["photos"];
  steps: GoldenStep[];
}

export interface GenerateResult {
  /** 파일명 -> 파일 내용. */
  files: Map<string, string>;
  isoMsMarkers: number;
}

function pick(body: unknown, jsonPath: string): string | number {
  if (!jsonPath.startsWith("$.")) throw new Error(`지원하지 않는 capture 경로: ${jsonPath}`);
  let cur: unknown = body;
  for (const key of jsonPath.slice(2).split(".")) {
    if (cur === null || typeof cur !== "object") throw new Error(`capture 경로에 값이 없습니다: ${jsonPath}`);
    cur = (cur as Record<string, unknown>)[key];
  }
  if (typeof cur !== "string" && typeof cur !== "number") throw new Error(`capture 값이 문자열/숫자가 아닙니다: ${jsonPath}`);
  return cur;
}

function substitute(text: string, vars: Map<string, string | number>): string {
  return text.replace(/\{(\w+)\}/g, (_m, name: string) => {
    const v = vars.get(name);
    if (v === undefined) throw new Error(`정의되지 않은 변수: ${name}`);
    return encodeURIComponent(String(v));
  });
}

function writeConfig(file: string, config: ScenarioDef["config"]): void {
  const base = JSON.parse(readFileSync(COLLECTOR_CONFIG, "utf8")) as {
    analysis: { reanalysisCooldownHours: number };
    observability: { maxRunsPerWorker: number };
  };
  if (config.maxRunsPerWorker !== undefined) base.observability.maxRunsPerWorker = config.maxRunsPerWorker;
  if (config.reanalysisCooldownHours !== undefined) base.analysis.reanalysisCooldownHours = config.reanalysisCooldownHours;
  writeFileSync(file, JSON.stringify(base, null, 2));
}

function preparePhotos(dbPath: string, photosDir: string, def: ScenarioDef): void {
  if (!def.photos?.length) return;
  const db = new Database(dbPath);
  try {
    const insert = db.prepare(
      "INSERT INTO item_photos (item_id, seq, file_path, file_size, mime_type, collected_at) VALUES (?, ?, ?, ?, ?, ?)",
    );
    for (const p of def.photos) {
      insert.run(p.itemId, p.seq, p.filePath, p.fileSize, p.mimeType, p.collectedAt);
      if (p.fixture !== null) {
        const dest = path.resolve(photosDir, p.filePath);
        mkdirSync(path.dirname(dest), { recursive: true });
        copyFileSync(path.join(PHOTO_FIXTURE_DIR, p.fixture), dest);
      }
    }
  } finally {
    db.close();
  }
}

type Handlers = Awaited<ReturnType<typeof loadHandlers>>;

async function loadHandlers() {
  const [analyses, runs, runById, runsSummary, bookmarks, bookmarkById, feed, feedRead, photos, items, itemById] =
    await Promise.all([
      import("../../src/app/api/analyses/route"),
      import("../../src/app/api/worker-runs/route"),
      import("../../src/app/api/worker-runs/[id]/route"),
      import("../../src/app/api/worker-runs/summary/route"),
      import("../../src/app/api/bookmarks/route"),
      import("../../src/app/api/bookmarks/[itemId]/route"),
      import("../../src/app/api/feed/route"),
      import("../../src/app/api/feed/read/route"),
      import("../../src/app/api/photos/[itemId]/[seq]/route"),
      import("../../src/app/api/items/route"),
      import("../../src/app/api/items/[id]/route"),
    ]);
  return { analyses, runs, runById, runsSummary, bookmarks, bookmarkById, feed, feedRead, photos, items, itemById };
}

async function dispatch(h: Handlers, method: string, pathname: string, req: Request): Promise<Response> {
  const key = `${method} ${pathname}`;
  const m = (re: RegExp) => re.exec(pathname);
  switch (key) {
    case "POST /api/analyses":
      return h.analyses.POST(req);
    case "POST /api/worker-runs":
      return h.runs.POST(req);
    case "GET /api/worker-runs":
      return h.runs.GET(req);
    case "GET /api/worker-runs/summary":
      return h.runsSummary.GET(req);
    case "GET /api/bookmarks":
      return h.bookmarks.GET(req);
    case "POST /api/bookmarks":
      return h.bookmarks.POST(req);
    case "GET /api/feed":
      return h.feed.GET(req);
    case "POST /api/feed/read":
      return h.feedRead.POST();
    case "GET /api/items":
      return h.items.GET(req);
  }
  let g: RegExpExecArray | null;
  if (method === "PATCH" && (g = m(/^\/api\/worker-runs\/([^/]+)$/)))
    return h.runById.PATCH(req, { params: Promise.resolve({ id: g[1] }) });
  if (method === "DELETE" && (g = m(/^\/api\/bookmarks\/([^/]+)$/)))
    return h.bookmarkById.DELETE(req, { params: Promise.resolve({ itemId: g[1] }) });
  if (method === "GET" && (g = m(/^\/api\/items\/([^/]+)$/)))
    return h.itemById.GET(req, { params: Promise.resolve({ id: g[1] }) });
  if (method === "GET" && (g = m(/^\/api\/photos\/([^/]+)\/([^/]+)$/)))
    return h.photos.GET(req as never, { params: Promise.resolve({ itemId: g[1], seq: g[2] }) });
  throw new Error(`시나리오가 지원하지 않는 요청: ${key}`);
}

async function runScenario(def: ScenarioDef, work: string, baseDb: string, h: Handlers): Promise<Golden> {
  const dir = mkdtempSync(path.join(work, `${def.name}-`));
  // 사진 디렉터리는 DB 파일 옆 photos/ 이다(getPhotosDir). `../outside.png`는 dir 안에 놓인다.
  const dbPath = path.join(dir, "auctionboss.db");
  copyFileSync(baseDb, dbPath);
  const configPath = path.join(dir, "collector.json");
  writeConfig(configPath, def.config);
  preparePhotos(dbPath, path.join(dir, "photos"), def);

  process.env.AUCTIONBOSS_DB = dbPath;
  process.env.AUCTIONBOSS_CONFIG = configPath;
  const { closeDb } = await import("../../src/lib/db");

  const vars = new Map<string, string | number>();
  const steps: GoldenStep[] = [];
  const startMs = Date.parse(CLOCK.start);
  const origError = console.error;
  try {
    for (const [i, step] of def.steps.entries()) {
      const nowIso = new Date(startMs + i * CLOCK.stepMs).toISOString();
      const resolvedPath = substitute(step.path, vars);
      const query = step.query ?? "";
      const url = `http://localhost${resolvedPath}${query ? `?${query}` : ""}`;
      const init: RequestInit = { method: step.method };
      if (step.rawBody !== undefined) init.body = step.rawBody;
      else if (step.body !== undefined) init.body = JSON.stringify(step.body);

      console.error = () => undefined; // 500 로그가 섞이지 않게(500은 아래에서 실패 처리)
      let res: Response;
      try {
        res = await withFixedNow(nowIso, () => dispatch(h, step.method, resolvedPath, new Request(url, init)));
      } finally {
        console.error = origError;
      }
      if (res.status >= 500) throw new Error(`${def.name} 단계 ${i}: 원본이 ${res.status}을 반환했다`);

      const golden: GoldenStep = {
        // 요청은 변수 치환 전 경로(`{run1}`)를 남긴다. Spring이 같은 변수로 치환한다.
        request: {
          method: step.method,
          path: step.path,
          query,
          ...(step.body !== undefined ? { body: step.body } : {}),
          ...(step.rawBody !== undefined ? { rawBody: step.rawBody } : {}),
        },
        status: res.status,
      };
      const contentType = res.headers.get("content-type");
      if (contentType?.includes("application/json")) {
        const body = (await res.json()) as unknown;
        golden.body = body;
        if (step.capture) {
          golden.capture = step.capture;
          for (const [name, jsonPath] of Object.entries(step.capture)) vars.set(name, pick(body, jsonPath));
        }
      } else if (res.status === 200 && resolvedPath.startsWith("/api/photos/")) {
        const bytes = Buffer.from(await res.arrayBuffer());
        golden.photo = {
          contentType,
          cacheControl: res.headers.get("cache-control"),
          sha256: createHash("sha256").update(bytes).digest("hex"),
        };
      } else {
        golden.text = await res.text();
      }
      steps.push(golden);
    }
  } finally {
    closeDb();
  }
  return {
    clock: { ...CLOCK },
    config: def.config,
    ...(def.photos ? { photos: def.photos } : {}),
    steps,
  };
}

/** 모든 시나리오를 만들어 파일명 -> 내용으로 돌려준다(파일은 쓰지 않는다). */
export async function generateAll(defs: ScenarioDef[] = SCENARIOS): Promise<GenerateResult> {
  const work = mkdtempSync(path.join(tmpdir(), "auctionboss-scenarios-"));
  const savedDb = process.env.AUCTIONBOSS_DB;
  const savedConfig = process.env.AUCTIONBOSS_CONFIG;
  try {
    const baseDb = path.join(work, "base.db");
    seedToSqlite(baseDb);
    const h = await loadHandlers();
    const files = new Map<string, string>();
    let markers = 0;
    for (const def of defs) {
      const golden = await runScenario(def, work, baseDb, h);
      const text = `${JSON.stringify(golden, null, 2)}\n`;
      markers += text.split(`"${ISO_MS_MARKER}"`).length - 1;
      files.set(`${def.name}.json`, text);
    }
    return { files, isoMsMarkers: markers };
  } finally {
    if (savedDb === undefined) delete process.env.AUCTIONBOSS_DB;
    else process.env.AUCTIONBOSS_DB = savedDb;
    if (savedConfig === undefined) delete process.env.AUCTIONBOSS_CONFIG;
    else process.env.AUCTIONBOSS_CONFIG = savedConfig;
    rmSync(work, { recursive: true, force: true });
  }
}

/** 원본 note에서 얻은 이름 목록으로 생성물을 점검한다. 목록은 이 함수 안에서만 쓰고 개수만 돌려준다. */
function countNameOccurrences(files: Map<string, string>): { names: number; occurrences: number } {
  const src = new Database(path.join(ROOT, "data/auctionboss.db"), { readonly: true });
  const names = new Set<string>();
  try {
    for (const r of src.prepare("SELECT note FROM items ORDER BY id").all() as { note: string | null }[]) {
      if (typeof r.note === "string") for (const n of extractPersonNames(r.note)) names.add(n);
    }
  } finally {
    src.close();
  }
  const combined = [...files.values()].join("\n");
  let occurrences = 0;
  for (const n of names) occurrences += combined.split(n).length - 1;
  return { names: names.size, occurrences };
}

async function main(): Promise<void> {
  const first = await generateAll();
  const second = await generateAll();
  for (const [name, text] of first.files) {
    if (second.files.get(name) !== text) throw new Error(`결정성 실패: ${name}이 두 번 생성에서 다르다`);
  }
  mkdirSync(SCENARIOS_DIR, { recursive: true });
  for (const f of readdirSync(SCENARIOS_DIR)) if (f.endsWith(".json")) rmSync(path.join(SCENARIOS_DIR, f));
  let stepCount = 0;
  for (const [name, text] of first.files) {
    writeFileSync(path.join(SCENARIOS_DIR, name), text);
    stepCount += (JSON.parse(text) as Golden).steps.length;
  }
  console.log(`시나리오 ${first.files.size}개, 단계 ${stepCount}개 작성: ${path.relative(ROOT, SCENARIOS_DIR)}`);
  console.log("결정성: 두 번 생성한 결과가 바이트 단위로 같다");
  console.log(`"${ISO_MS_MARKER}" 표식 ${first.isoMsMarkers}개`);

  // 이름 점검: 개수만 출력한다. 원본 DB는 이 점검에서만, 이름 목록을 얻기 위해 읽기 전용으로 연다.
  const check = countNameOccurrences(first.files);
  console.log(`이름 점검: 대상 ${check.names}개, 생성물 안 출현 ${check.occurrences}회`);
  if (check.occurrences !== 0 || first.isoMsMarkers !== 0) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
