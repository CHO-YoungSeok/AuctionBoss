import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseClaudeEnvelope } from "../../../workers/lib/claude";

const bin = join(__dirname, "..", "fake-claude");

describe("scripts/dev/fake-claude", () => {
  it("실행 권한이 있다", () => {
    expect(statSync(bin).mode & 0o111).not.toBe(0);
  });

  it("출력이 분석 워커의 parseClaudeEnvelope를 통과하고 모델은 fake-claude다", () => {
    const stdout = execFileSync(bin, ["--print", "--output-format", "json"], { input: "프롬프트" }).toString();
    const result = parseClaudeEnvelope(stdout);
    expect(result.model).toBe("fake-claude");
    expect(result.text).toContain("개발 검증용 가짜 분석");
  });
});
