/**
 * 어댑터 골든 생성 (port-collector-to-spring 1.4, D5).
 *
 * 사례마다 Node 루프백 서버를 띄워 응답 시퀀스를 재생하고, 기존 TS `CourtAuctionAdapter`를 실제
 * `fetch`로 그 서버에 붙여 부른다. 받은 요청(메서드, 경로, 헤더, 본문)과 기록용 `sleep` 호출,
 * 고정 `now`, 결과(물건·사진·오류 종류)를 backend/src/test/resources/contracts/source/{사례}.json 으로 쓴다.
 * 어댑터 코드는 바꾸지 않는다. 외부 사이트에는 요청하지 않는다(루프백 서버만, loopback.ts).
 *
 * 골든 형식:
 *   { description, now, options, call, repeat, responses, expected: Outcome[], requests, sleeps }
 *   - expected: 호출마다 하나(길이 = repeat).
 *       { items, pagesRequested } | { photos: [{ seq, base64Length, base64Sha256 }], requestsMade }
 *       | { error: { kind, requestsMade, messageHead } }
 *     오류의 requestsMade는 `error.pagesRequested ?? 0`, messageHead는 메시지 첫 줄(서버 주소는 {base}).
 *   - requests: 받은 순서 그대로의 헤더 [이름, 값] 목록(서버 주소는 {base}, host 값은 {host}).
 *   - sleeps: 기록용 sleep 호출 { ms, afterRequests }. afterRequests는 그때까지 서버가 받은 요청 수다.
 *
 * 실행: npx tsx --tsconfig scripts/dev/tsconfig.snapshot.json scripts/collector-golden/generate-source-goldens.ts
 */
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { SOURCE_CONTRACTS_DIR } from "./extract-fixtures";
import { buildFixtureSet, type FixtureSet } from "./fixtures";
import { loopbackOnlyFetch, maskBase, withLoopbackServer, type RecordedRequest } from "./loopback";
import { GOLDEN_NOW, buildSourceCases, type SourceCaseDef } from "./source-cases";
import { CourtAuctionAdapter, SourceError, type Logger } from "../../src/lib/sources";

const ROOT = path.resolve(__dirname, "../..");

export interface SleepRecord {
  ms: number;
  afterRequests: number;
}

export type Outcome =
  | { items: unknown[]; pagesRequested: number }
  | { photos: { seq: number; base64Length: number; base64Sha256: string }[]; requestsMade: number }
  | { error: { kind: string; requestsMade: number; messageHead: string } };

export interface SourceGolden {
  description: string;
  now: string;
  options: SourceCaseDef["options"];
  call: SourceCaseDef["call"];
  repeat: number;
  responses: SourceCaseDef["responses"];
  expected: Outcome[];
  requests: RecordedRequest[];
  sleeps: SleepRecord[];
}

const silentLogger: Logger = { info() {}, warn() {}, error() {} };

async function runCase(def: SourceCaseDef): Promise<{ golden: SourceGolden; maxConcurrent: number }> {
  const sleeps: SleepRecord[] = [];
  const expected: Outcome[] = [];

  const { requests, maxConcurrent } = await withLoopbackServer(def.responses, async (baseUrl, seen) => {
    const adapter = new CourtAuctionAdapter({
      baseUrl,
      fetchFn: loopbackOnlyFetch,
      logger: silentLogger,
      sleep: async (ms) => {
        sleeps.push({ ms, afterRequests: seen.length });
      },
      now: () => new Date(GOLDEN_NOW),
      ...def.options,
    });
    for (let i = 0; i < def.repeat; i += 1) {
      try {
        if (def.call.kind === "activeItems") {
          const { items, pagesRequested } = await adapter.fetchActiveItems(def.call.scope);
          expected.push({ items, pagesRequested });
        } else {
          const { photos, requestsMade } = await adapter.fetchItemPhotos(def.call.ref);
          expected.push({
            photos: photos.map((p) => ({
              seq: p.seq,
              base64Length: p.base64.length,
              base64Sha256: createHash("sha256").update(p.base64).digest("hex"),
            })),
            requestsMade,
          });
        }
      } catch (error) {
        if (!(error instanceof SourceError)) throw error;
        expected.push({
          error: {
            kind: error.name,
            requestsMade: error.pagesRequested ?? 0,
            messageHead: maskBase(error.message.split("\n")[0]!, baseUrl),
          },
        });
      }
    }
  });

  return {
    golden: {
      description: def.description,
      now: GOLDEN_NOW,
      options: def.options,
      call: def.call,
      repeat: def.repeat,
      responses: def.responses,
      expected,
      requests,
      sleeps,
    },
    maxConcurrent,
  };
}

export interface SourceGenerateResult {
  /** 파일명 -> 파일 내용. */
  files: Map<string, string>;
  goldens: Map<string, SourceGolden>;
  /** 사례별로 서버가 동시에 처리한 요청 수의 최대값. */
  maxConcurrent: Map<string, number>;
}

/** 모든 사례를 만들어 돌려준다(파일은 쓰지 않는다). */
export async function generateSourceGoldens(
  cases: SourceCaseDef[] = buildSourceCases(buildFixtureSet() as FixtureSet),
): Promise<SourceGenerateResult> {
  const files = new Map<string, string>();
  const goldens = new Map<string, SourceGolden>();
  const maxConcurrent = new Map<string, number>();
  for (const def of cases) {
    const { golden, maxConcurrent: mc } = await runCase(def);
    files.set(`${def.name}.json`, `${JSON.stringify(golden, null, 2)}\n`);
    goldens.set(def.name, golden);
    maxConcurrent.set(def.name, mc);
  }
  return { files, goldens, maxConcurrent };
}

async function main(): Promise<void> {
  const first = await generateSourceGoldens();
  const second = await generateSourceGoldens();
  for (const [name, text] of first.files) {
    if (second.files.get(name) !== text) throw new Error(`결정성 실패: ${name}이 두 번 생성에서 다르다`);
  }
  mkdirSync(SOURCE_CONTRACTS_DIR, { recursive: true });
  for (const f of readdirSync(SOURCE_CONTRACTS_DIR)) {
    if (f.endsWith(".json")) rmSync(path.join(SOURCE_CONTRACTS_DIR, f));
  }
  for (const [name, text] of first.files) writeFileSync(path.join(SOURCE_CONTRACTS_DIR, name), text);
  console.log(`어댑터 골든 ${first.files.size}개 작성: ${path.relative(ROOT, SOURCE_CONTRACTS_DIR)}`);
  console.log("결정성: 두 번 생성한 결과가 바이트 단위로 같다");
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
