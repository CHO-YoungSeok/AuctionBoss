/**
 * 저장 골든 생성 (port-collector-to-spring 1.5, D6).
 *
 * 시나리오(store-scenarios.ts)마다 빈 임시 SQLite와 임시 사진 디렉터리를 만들고, 기존
 * `startCollector`·`startPhotoWorker`를 `runImmediately: false`로 띄워 단계마다 `tick()`을 직접 부른다.
 * 소스는 시나리오가 정한 응답을 돌려주는 가짜 `AuctionSource`이고, "지금"은 scripts/seed/fixed-clock.ts로
 * 단계 시각에 고정한다. 단계 뒤마다 `items`·`item_changes`·`worker_runs`·`collector_state`·`item_photos`와
 * 사진 파일, 가짜 소스가 받은 호출을 스냅숏으로 남겨 backend/src/test/resources/contracts/collector/{이름}.json 에 쓴다.
 * 워커 코드는 바꾸지 않는다. 네트워크에는 아무것도 보내지 않는다(소스가 가짜).
 *
 * 골든 형식: { description, clock, config: { scope, photos }, steps: [{ label, at, input, calls, sleeps, tickResult, snapshot }] }
 *   - input: 단계 정의 그대로(소스 응답 스크립트와 준비 작업 포함). Java 재생이 같은 스크립트를 쓴다.
 *   - calls: 가짜 소스가 받은 호출. 수집은 { courtCode, courtName }, 사진은 { courtCode, internalCaseNo }.
 *   - sleeps: 사진 워커가 건 기록용 대기(ms). 수집 단계는 빈 배열.
 *   - tickResult: 사진 틱의 반환값(success|failed|blocked|skipped). 수집 틱은 반환값이 없어 null.
 *   - snapshot: { items, itemChanges, workerRuns(detail은 파싱), collectorState, itemPhotos, photoFiles: [{ path, size, sha256 }] }
 *     값은 SQLite 원문 그대로다(시각은 밀리초 3자리 Z 문자열). MySQL 쪽 비교는 시각·숫자를 같은 규칙으로 정규화한다.
 *
 * 실행: npx tsx --tsconfig scripts/dev/tsconfig.snapshot.json scripts/collector-golden/generate-store-goldens.ts
 */
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { startCollector } from "../../workers/collector";
import { startPhotoWorker } from "../../workers/photos";
import { closeDb, extendBackoffUntil, getDb } from "../../src/lib/db";
import {
  RobotDetectedError,
  ResponseSchemaError,
  SourceRequestError,
  WafBlockedError,
  attachPagesRequested,
  type AuctionSource,
  type Logger,
  type SourceError,
} from "../../src/lib/sources";
import { withFixedNow } from "../seed/fixed-clock";
import {
  STORE_SCENARIOS,
  T0,
  type PhotoResult,
  type ScriptedError,
  type SearchResult,
  type StepDef,
  type StoreScenarioDef,
} from "./store-scenarios";

const ROOT = path.resolve(__dirname, "../..");
export const COLLECTOR_CONTRACTS_DIR = path.join(ROOT, "backend/src/test/resources/contracts/collector");
const COLLECTOR_CONFIG = path.join(ROOT, "config/collector.json");

const silentLogger: Logger = { info() {}, warn() {}, error() {} };

export interface StoreSnapshot {
  items: Record<string, unknown>[];
  itemChanges: Record<string, unknown>[];
  workerRuns: Record<string, unknown>[];
  collectorState: Record<string, unknown>[];
  itemPhotos: Record<string, unknown>[];
  photoFiles: { path: string; size: number; sha256: string }[];
}

export interface StoreGoldenStep {
  label: string;
  at: string;
  input: StepDef;
  calls: Record<string, string>[];
  sleeps: number[];
  tickResult: string | null;
  snapshot: StoreSnapshot;
}

export interface StoreGolden {
  description: string;
  clock: { t0: string };
  config: { scope: StoreScenarioDef["scope"]; photos: StoreScenarioDef["photos"] };
  steps: StoreGoldenStep[];
}

function makeError(e: ScriptedError): SourceError {
  let error: SourceError;
  switch (e.kind) {
    case "RobotDetectedError":
      error = new RobotDetectedError(e.message, null);
      break;
    case "WafBlockedError":
      error = new WafBlockedError(e.message, "");
      break;
    case "ResponseSchemaError":
      error = new ResponseSchemaError(e.message, []);
      break;
    case "SourceRequestError":
      error = new SourceRequestError(e.message, { url: "http://loopback.invalid/" });
      break;
  }
  if (e.requestsMade !== undefined) attachPagesRequested(error, e.requestsMade);
  return error;
}

function walkFiles(dir: string, base = dir): string[] {
  let out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir).sort();
  } catch {
    return out;
  }
  for (const name of entries) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out = out.concat(walkFiles(full, base));
    else out.push(path.relative(base, full).split(path.sep).join("/"));
  }
  return out;
}

function takeSnapshot(photosDir: string): StoreSnapshot {
  const db = getDb();
  const all = (sql: string) => db.prepare(sql).all() as Record<string, unknown>[];
  const workerRuns = all("SELECT * FROM worker_runs ORDER BY id").map((r) => ({
    ...r,
    detail: typeof r.detail === "string" ? (JSON.parse(r.detail) as unknown) : null,
  }));
  const photoFiles = walkFiles(photosDir)
    .sort()
    .map((rel) => {
      const bytes = readFileSync(path.join(photosDir, rel));
      return { path: rel, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
    });
  return {
    items: all("SELECT * FROM items ORDER BY id"),
    itemChanges: all("SELECT * FROM item_changes ORDER BY id"),
    workerRuns,
    collectorState: all("SELECT * FROM collector_state ORDER BY key"),
    itemPhotos: all("SELECT * FROM item_photos ORDER BY id"),
    photoFiles,
  };
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

async function runStep(def: StoreScenarioDef, step: StepDef, photosDir: string): Promise<StoreGoldenStep> {
  const calls: Record<string, string>[] = [];
  const sleeps: number[] = [];
  let tickResult: string | null = null;

  if (step.run === "collector") {
    const scripted = new Map<string, SearchResult>(Object.entries(clone(step.search)));
    const called = new Set<string>();
    const source: AuctionSource = {
      async fetchActiveItems(scope) {
        const court = scope.courts[0]!;
        calls.push({ courtCode: court.courtCode, courtName: court.name });
        called.add(court.courtCode);
        const result = scripted.get(court.courtCode);
        if (!result) throw new Error(`스크립트에 없는 법원 호출: ${court.courtCode} (${def.name} / ${step.label})`);
        if ("error" in result) throw makeError(result.error);
        return { items: result.items, pagesRequested: result.pagesRequested };
      },
      async fetchItemPhotos() {
        throw new Error("수집 단계에서 사진 조회는 일어나지 않아야 한다");
      },
    };
    const handle = startCollector({
      source,
      scope: clone(step.scope ?? def.scope),
      intervalMs: 3_600_000,
      logger: silentLogger,
      runImmediately: false,
    });
    try {
      await withFixedNow(step.at, () => handle.tick());
    } finally {
      await handle.stop();
    }
    for (const code of scripted.keys()) {
      if (!called.has(code)) throw new Error(`스크립트한 법원이 호출되지 않았다: ${code} (${def.name} / ${step.label})`);
    }
  } else if (step.run === "photos") {
    const scripted: PhotoResult[] = clone(step.results);
    let next = 0;
    const source: AuctionSource = {
      async fetchActiveItems() {
        throw new Error("사진 단계에서 검색은 일어나지 않아야 한다");
      },
      async fetchItemPhotos(ref) {
        calls.push({ courtCode: ref.courtCode, internalCaseNo: ref.internalCaseNo });
        const result = scripted[next];
        next += 1;
        if (!result) throw new Error(`스크립트에 없는 사진 호출 ${next}번째 (${def.name} / ${step.label})`);
        if ("error" in result) throw makeError(result.error);
        return { photos: result.photos, requestsMade: result.requestsMade };
      },
    };
    const handle = startPhotoWorker({
      createSource: () => source,
      config: clone(step.photosConfig ?? def.photos),
      logger: silentLogger,
      now: () => new Date(),
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      runImmediately: false,
    });
    try {
      tickResult = await withFixedNow(step.at, () => handle.tick());
    } finally {
      await handle.stop();
    }
    if (next !== scripted.length) {
      throw new Error(`스크립트한 사진 결과 ${scripted.length}개 중 ${next}개만 쓰였다 (${def.name} / ${step.label})`);
    }
  } else {
    const op = step.op;
    if (op.kind === "extendBackoff") {
      await withFixedNow(step.at, () => extendBackoffUntil(new Date(op.until)));
    } else {
      const info = getDb()
        .prepare(
          "UPDATE items SET photo_status = @status, photo_attempted_at = @attemptedAt WHERE court = @court AND case_no = @caseNo AND item_no = @itemNo",
        )
        .run({ status: op.status, attemptedAt: op.attemptedAt, court: op.court, caseNo: op.caseNo, itemNo: op.itemNo });
      if (info.changes !== 1) throw new Error(`준비 작업 대상 물건을 못 찾았다: ${op.caseNo} (${def.name} / ${step.label})`);
    }
  }

  return {
    label: step.label,
    at: step.at,
    input: clone(step),
    calls,
    sleeps,
    tickResult,
    snapshot: takeSnapshot(photosDir),
  };
}

async function runScenario(def: StoreScenarioDef, work: string): Promise<StoreGolden> {
  const dir = mkdtempSync(path.join(work, `${def.name}-`));
  process.env.AUCTIONBOSS_DB = path.join(dir, "auctionboss.db");
  process.env.AUCTIONBOSS_CONFIG = COLLECTOR_CONFIG;
  const photosDir = path.join(dir, "photos");
  const steps: StoreGoldenStep[] = [];
  try {
    for (const step of def.steps) steps.push(await runStep(def, step, photosDir));
  } finally {
    closeDb();
  }
  return { description: def.description, clock: { t0: T0 }, config: { scope: def.scope, photos: def.photos }, steps };
}

export interface StoreGenerateResult {
  /** 파일명 -> 파일 내용. */
  files: Map<string, string>;
  goldens: Map<string, StoreGolden>;
}

/** 모든 시나리오를 만들어 돌려준다(파일은 쓰지 않는다). */
export async function generateStoreGoldens(defs: StoreScenarioDef[] = STORE_SCENARIOS): Promise<StoreGenerateResult> {
  const work = mkdtempSync(path.join(tmpdir(), "auctionboss-store-goldens-"));
  const savedDb = process.env.AUCTIONBOSS_DB;
  const savedConfig = process.env.AUCTIONBOSS_CONFIG;
  try {
    const files = new Map<string, string>();
    const goldens = new Map<string, StoreGolden>();
    for (const def of defs) {
      const golden = await runScenario(def, work);
      files.set(`${def.name}.json`, `${JSON.stringify(golden, null, 2)}\n`);
      goldens.set(def.name, golden);
    }
    return { files, goldens };
  } finally {
    if (savedDb === undefined) delete process.env.AUCTIONBOSS_DB;
    else process.env.AUCTIONBOSS_DB = savedDb;
    if (savedConfig === undefined) delete process.env.AUCTIONBOSS_CONFIG;
    else process.env.AUCTIONBOSS_CONFIG = savedConfig;
    rmSync(work, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const first = await generateStoreGoldens();
  const second = await generateStoreGoldens();
  for (const [name, text] of first.files) {
    if (second.files.get(name) !== text) throw new Error(`결정성 실패: ${name}이 두 번 생성에서 다르다`);
  }
  mkdirSync(COLLECTOR_CONTRACTS_DIR, { recursive: true });
  for (const f of readdirSync(COLLECTOR_CONTRACTS_DIR)) {
    if (f.endsWith(".json")) rmSync(path.join(COLLECTOR_CONTRACTS_DIR, f));
  }
  let stepCount = 0;
  for (const [name, text] of first.files) {
    writeFileSync(path.join(COLLECTOR_CONTRACTS_DIR, name), text);
    stepCount += (JSON.parse(text) as StoreGolden).steps.length;
  }
  console.log(`저장 골든 시나리오 ${first.files.size}개, 단계 ${stepCount}개 작성: ${path.relative(ROOT, COLLECTOR_CONTRACTS_DIR)}`);
  console.log("결정성: 두 번 생성한 결과가 바이트 단위로 같다");
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
