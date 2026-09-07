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
