/**
 * TS 어댑터 테스트 픽스처를 JSON으로 추출한다 (port-collector-to-spring 1.3, D5).
 *
 * 출력: backend/src/test/resources/contracts/source/fixtures/{search-rows,detail-response,bodies}.json
 * 상세 응답의 이름 필드는 가림 표기로 바뀐다(fixtures.ts). 기존 TS 픽스처는 고치지 않고 읽기만 한다.
 *
 * 실행: npx tsx --tsconfig scripts/dev/tsconfig.snapshot.json scripts/collector-golden/extract-fixtures.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { buildFixtureSet, type FixtureSet } from "./fixtures";

const ROOT = path.resolve(__dirname, "../..");
export const SOURCE_CONTRACTS_DIR = path.join(ROOT, "backend/src/test/resources/contracts/source");
export const FIXTURES_DIR = path.join(SOURCE_CONTRACTS_DIR, "fixtures");

/** 파일명 -> 내용. 파일은 쓰지 않는다. */
export function renderFixtureFiles(set: FixtureSet = buildFixtureSet()): Map<string, string> {
  const text = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;
  return new Map([
    ["search-rows.json", text(set.searchRows)],
    ["detail-response.json", text(set.detailResponse)],
    ["bodies.json", text(set.bodies)],
  ]);
}

function main(): void {
  mkdirSync(FIXTURES_DIR, { recursive: true });
  for (const [name, content] of renderFixtureFiles()) writeFileSync(path.join(FIXTURES_DIR, name), content);
  console.log(`픽스처 JSON 3개 작성: ${path.relative(ROOT, FIXTURES_DIR)}`);
}

if (require.main === module) main();
