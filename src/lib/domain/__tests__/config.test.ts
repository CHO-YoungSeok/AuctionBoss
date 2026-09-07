import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CollectorConfigError, loadCollectorConfig } from "../config";

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(path.join(tmpdir(), "auctionboss-config-"));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function writeConfig(content: string): string {
  const file = path.join(workDir, `${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(file, content, "utf8");
  return file;
}

describe("loadCollectorConfig", () => {
  it("저장소의 실제 config/collector.json을 읽어 검증한다", () => {
    const config = loadCollectorConfig({
      configPath: path.resolve(process.cwd(), "config/collector.json"),
      reload: true,
    });

    expect(config.scope.courts.length).toBeGreaterThan(0);
    expect(config.intervalMs).toBeGreaterThan(0);
    expect(config.analysis.maxItemsPerRun).toBeGreaterThan(0);
    expect(config.analysis.maxReanalysisPerRun).toBeGreaterThan(0);
    expect(config.analysis.reanalysisCooldownHours).toBeGreaterThanOrEqual(0);
  });

  it("reanalysisCooldownHours가 없거나 잘못된 값이면 기본값으로 조용히 넘어가지 않고 throw한다(코드 리뷰 finding 3)", () => {
    const missing = writeConfig(
      JSON.stringify({
        scope: { courts: [{ name: "서울중앙지방법원", courtCode: "" }] },
        intervalMs: 600000,
        analysis: { maxItemsPerRun: 5, maxReanalysisPerRun: 2, intervalMs: 600000 },
      }),
    );
    expect(() => loadCollectorConfig({ configPath: missing, reload: true })).toThrow(
      /reanalysisCooldownHours/,
    );

    const negative = writeConfig(
      JSON.stringify({
        scope: { courts: [{ name: "서울중앙지방법원", courtCode: "" }] },
        intervalMs: 600000,
        analysis: {
          maxItemsPerRun: 5,
          maxReanalysisPerRun: 2,
          reanalysisCooldownHours: -1,
          intervalMs: 600000,
        },
      }),
    );
    expect(() => loadCollectorConfig({ configPath: negative, reload: true })).toThrow(
      /reanalysisCooldownHours/,
    );

    const notInt = writeConfig(
      JSON.stringify({
        scope: { courts: [{ name: "서울중앙지방법원", courtCode: "" }] },
        intervalMs: 600000,
        analysis: {
          maxItemsPerRun: 5,
          maxReanalysisPerRun: 2,
          reanalysisCooldownHours: "하루",
          intervalMs: 600000,
        },
      }),
    );
    expect(() => loadCollectorConfig({ configPath: notInt, reload: true })).toThrow(
      /reanalysisCooldownHours/,
    );
  });

  it("reanalysisCooldownHours: 0은 허용한다(쿨다운 없음)", () => {
    const zero = writeConfig(
      JSON.stringify({
        scope: { courts: [{ name: "서울중앙지방법원", courtCode: "" }] },
        intervalMs: 600000,
        analysis: {
          maxItemsPerRun: 5,
          maxReanalysisPerRun: 2,
          reanalysisCooldownHours: 0,
          intervalMs: 600000,
        },
      }),
    );
    expect(
      loadCollectorConfig({ configPath: zero, reload: true }).analysis.reanalysisCooldownHours,
    ).toBe(0);
  });

  it("maxReanalysisPerRun이 없거나 잘못된 값이면 기본값으로 조용히 넘어가지 않고 throw한다(design.md D5)", () => {
    const missing = writeConfig(
      JSON.stringify({
        scope: { courts: [{ name: "서울중앙지방법원", courtCode: "" }] },
        intervalMs: 600000,
        analysis: { maxItemsPerRun: 5, intervalMs: 600000 },
      }),
    );
    expect(() => loadCollectorConfig({ configPath: missing, reload: true })).toThrow(
      /maxReanalysisPerRun/,
    );

    const zero = writeConfig(
      JSON.stringify({
        scope: { courts: [{ name: "서울중앙지방법원", courtCode: "" }] },
        intervalMs: 600000,
        analysis: { maxItemsPerRun: 5, maxReanalysisPerRun: 0, intervalMs: 600000 },
      }),
    );
    expect(() => loadCollectorConfig({ configPath: zero, reload: true })).toThrow(
      /maxReanalysisPerRun/,
    );

    const negative = writeConfig(
      JSON.stringify({
        scope: { courts: [{ name: "서울중앙지방법원", courtCode: "" }] },
        intervalMs: 600000,
        analysis: { maxItemsPerRun: 5, maxReanalysisPerRun: -1, intervalMs: 600000 },
      }),
    );
    expect(() => loadCollectorConfig({ configPath: negative, reload: true })).toThrow(
      /maxReanalysisPerRun/,
    );

    const notInt = writeConfig(
      JSON.stringify({
        scope: { courts: [{ name: "서울중앙지방법원", courtCode: "" }] },
        intervalMs: 600000,
        analysis: { maxItemsPerRun: 5, maxReanalysisPerRun: "두 건", intervalMs: 600000 },
      }),
    );
    expect(() => loadCollectorConfig({ configPath: notInt, reload: true })).toThrow(
      /maxReanalysisPerRun/,
    );
  });

  it("파일이 없으면 기본값으로 넘어가지 않고 throw한다", () => {
    expect(() =>
      loadCollectorConfig({ configPath: path.join(workDir, "missing.json"), reload: true }),
    ).toThrow(CollectorConfigError);
  });

  it("JSON이 깨져 있으면 throw한다", () => {
    const file = writeConfig("{ not json");
    expect(() => loadCollectorConfig({ configPath: file, reload: true })).toThrow(
      CollectorConfigError,
    );
  });

  it("필드가 빠졌거나 타입이 다르면 어떤 필드가 문제인지 알려주며 throw한다", () => {
    const file = writeConfig(
      JSON.stringify({
        scope: { courts: [{ name: "서울중앙지방법원", courtCode: "" }] },
        intervalMs: "10분",
        analysis: { maxItemsPerRun: 5, intervalMs: 600000 },
      }),
    );

    expect(() => loadCollectorConfig({ configPath: file, reload: true })).toThrow(/intervalMs/);
  });

  it("수집 대상 법원이 하나도 없으면 throw한다", () => {
    const file = writeConfig(
      JSON.stringify({
        scope: { courts: [] },
        intervalMs: 600000,
        analysis: { maxItemsPerRun: 5, intervalMs: 600000 },
      }),
    );

    expect(() => loadCollectorConfig({ configPath: file, reload: true })).toThrow(
      CollectorConfigError,
    );
  });
});
