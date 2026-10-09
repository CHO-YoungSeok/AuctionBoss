import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { extractPersonNames } from "../../seed/masking";
import { parseSeedSql } from "../../seed/seed-to-sqlite";
import { GOLDEN_DIR, generateGolden, readTree } from "../generate-migration-golden";

let work: string;
beforeAll(() => {
  work = mkdtempSync(path.join(tmpdir(), "golden-test-"));
});
afterAll(() => rmSync(work, { recursive: true, force: true }));

describe("교차 언어 골든", () => {
  it("합성값만 쓴다: 모든 문자열 값에서 이름 추출이 0건이다", async () => {
    const dir = path.join(work, "names");
    await generateGolden(dir);
    let strings = 0;
    let names = 0;
    for (const f of readdirSync(path.join(dir, "sql"))) {
      for (const st of parseSeedSql(readFileSync(path.join(dir, "sql", f), "utf8"))) {
        for (const row of st.rows) {
          for (const v of row) {
            if (typeof v !== "string") continue;
            strings++;
            names += extractPersonNames(v).length;
          }
        }
      }
    }
    expect(strings).toBeGreaterThan(50);
    expect(names).toBe(0);
  });

  it("두 번 생성하면 바이트 단위로 같다", async () => {
    await generateGolden(path.join(work, "a"));
    await generateGolden(path.join(work, "b"));
    expect(readTree(path.join(work, "b"))).toEqual(readTree(path.join(work, "a")));
  });

  it("커밋된 골든이 현재 생성기 결과와 같다(오래된 골든 방지)", async () => {
    await generateGolden(path.join(work, "fresh"));
    expect(readTree(GOLDEN_DIR)).toEqual(readTree(path.join(work, "fresh")));
  });

  it("매니페스트에 고정 필드가 들어 있다", () => {
    const m = JSON.parse(readFileSync(path.join(GOLDEN_DIR, "manifest.json"), "utf8"));
    expect(m).toMatchObject({ ruleVersion: 1, sourceSha256: null, toolCommit: "golden" });
    expect(Object.keys(m.tables)).toHaveLength(8);
  });
});
