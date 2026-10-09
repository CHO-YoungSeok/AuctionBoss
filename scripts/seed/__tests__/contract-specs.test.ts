import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { buildSpecs } from "../contract-specs";

const CONTRACTS = path.resolve(__dirname, "../../../backend/src/test/resources/contracts");
const SEED_TOTAL = 809;

describe("contract-specs: 요청 목록이 커밋된 계약 골든과 같다", () => {
  // generate-contracts.ts에서 buildSpecs를 분리했다. 목록이 조금이라도 달라지면 골든 재생성이 몰래 바뀐다.
  it("모든 요청의 이름·경로·쿼리가 골든 파일의 request와 일치한다", () => {
    const specs = buildSpecs(SEED_TOTAL);
    expect(specs.length).toBe(90);
    for (const s of specs) {
      const file = path.join(CONTRACTS, `${s.name}.json`);
      expect(existsSync(file), `${s.name} 골든 없음`).toBe(true);
      const golden = JSON.parse(readFileSync(file, "utf8")) as { request: { path: string; query: string } };
      expect({ path: golden.request.path, query: golden.request.query }, s.name).toEqual({ path: s.path, query: s.query });
    }
  });

  it("이름이 중복되지 않는다", () => {
    const names = buildSpecs(SEED_TOTAL).map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
