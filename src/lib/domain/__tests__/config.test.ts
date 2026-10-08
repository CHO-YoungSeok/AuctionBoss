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

const VALID_PHOTOS = {
  intervalMs: 1800000,
  maxItemsPerRun: 5,
  requestDelayMs: 30000,
  retryAfterHours: 24,
};

function fullConfig(photos: unknown): string {
  return writeConfig(
    JSON.stringify({
      scope: {
        courts: [{ name: "서울중앙지방법원", courtCode: "B000210" }],
        maxCourtsPerRun: 1,
        maxRequestsPerRun: 13,
      },
      intervalMs: 600000,
      analysis: {
        maxItemsPerRun: 5,
        maxReanalysisPerRun: 2,
        reanalysisCooldownHours: 24,
        intervalMs: 600000,
      },
      photos,
      observability: { maxRunsPerWorker: 1000, staleAfterIntervals: 3 },
    }),
  );
}

describe("loadCollectorConfig", () => {
  it("저장소의 실제 config/collector.json을 읽어 검증한다", () => {
    const config = loadCollectorConfig({
      configPath: path.resolve(process.cwd(), "config/collector.json"),
      reload: true,
    });

    expect(config.scope.courts.length).toBeGreaterThan(0);
    expect(config.scope.maxCourtsPerRun).toBeGreaterThan(0);
    expect(config.scope.maxRequestsPerRun).toBeGreaterThan(0);
    expect(config.intervalMs).toBeGreaterThan(0);
    expect(config.analysis.maxItemsPerRun).toBeGreaterThan(0);
    expect(config.analysis.maxReanalysisPerRun).toBeGreaterThan(0);
    expect(config.analysis.reanalysisCooldownHours).toBeGreaterThanOrEqual(0);
    expect(config.observability.maxRunsPerWorker).toBeGreaterThan(0);
    expect(config.observability.staleAfterIntervals).toBeGreaterThan(0);
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
        scope: {
          courts: [{ name: "서울중앙지방법원", courtCode: "" }],
          maxCourtsPerRun: 1,
          maxRequestsPerRun: 13,
        },
        intervalMs: 600000,
        analysis: {
          maxItemsPerRun: 5,
          maxReanalysisPerRun: 2,
          reanalysisCooldownHours: 0,
          intervalMs: 600000,
        },
        photos: VALID_PHOTOS,
        observability: { maxRunsPerWorker: 1000, staleAfterIntervals: 3 },
      }),
    );
    expect(
      loadCollectorConfig({ configPath: zero, reload: true }).analysis.reanalysisCooldownHours,
    ).toBe(0);
  });

  it("observability.maxRunsPerWorker/staleAfterIntervals이 없거나 잘못된 값이면 throw한다(add-collection-observability design.md D6)", () => {
    const baseConfig = {
      scope: { courts: [{ name: "서울중앙지방법원", courtCode: "" }] },
      intervalMs: 600000,
      analysis: {
        maxItemsPerRun: 5,
        maxReanalysisPerRun: 2,
        reanalysisCooldownHours: 24,
        intervalMs: 600000,
      },
    };

    const missing = writeConfig(JSON.stringify(baseConfig));
    expect(() => loadCollectorConfig({ configPath: missing, reload: true })).toThrow(
      /observability/,
    );

    const zero = writeConfig(
      JSON.stringify({
        ...baseConfig,
        observability: { maxRunsPerWorker: 0, staleAfterIntervals: 3 },
      }),
    );
    expect(() => loadCollectorConfig({ configPath: zero, reload: true })).toThrow(
      /maxRunsPerWorker/,
    );

    const negative = writeConfig(
      JSON.stringify({
        ...baseConfig,
        observability: { maxRunsPerWorker: 1000, staleAfterIntervals: -1 },
      }),
    );
    expect(() => loadCollectorConfig({ configPath: negative, reload: true })).toThrow(
      /staleAfterIntervals/,
    );

    const notInt = writeConfig(
      JSON.stringify({
        ...baseConfig,
        observability: { maxRunsPerWorker: "천 개", staleAfterIntervals: 3 },
      }),
    );
    expect(() => loadCollectorConfig({ configPath: notInt, reload: true })).toThrow(
      /maxRunsPerWorker/,
    );
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

  it("scope.maxCourtsPerRun/maxRequestsPerRun이 없거나 잘못된 값이면 기본값으로 조용히 넘어가지 않고 throw한다(scale-collection-scheduling task 1.1)", () => {
    const baseConfig = {
      intervalMs: 600000,
      analysis: {
        maxItemsPerRun: 5,
        maxReanalysisPerRun: 2,
        reanalysisCooldownHours: 24,
        intervalMs: 600000,
      },
      observability: { maxRunsPerWorker: 1000, staleAfterIntervals: 3 },
    };
    const courts = [{ name: "서울중앙지방법원", courtCode: "B000210" }];

    const missing = writeConfig(JSON.stringify({ ...baseConfig, scope: { courts } }));
    expect(() => loadCollectorConfig({ configPath: missing, reload: true })).toThrow(
      /maxCourtsPerRun/,
    );

    const zero = writeConfig(
      JSON.stringify({
        ...baseConfig,
        scope: { courts, maxCourtsPerRun: 0, maxRequestsPerRun: 13 },
      }),
    );
    expect(() => loadCollectorConfig({ configPath: zero, reload: true })).toThrow(
      /maxCourtsPerRun/,
    );

    const negative = writeConfig(
      JSON.stringify({
        ...baseConfig,
        scope: { courts, maxCourtsPerRun: 1, maxRequestsPerRun: -1 },
      }),
    );
    expect(() => loadCollectorConfig({ configPath: negative, reload: true })).toThrow(
      /maxRequestsPerRun/,
    );

    const notInt = writeConfig(
      JSON.stringify({
        ...baseConfig,
        scope: { courts, maxCourtsPerRun: 1.5, maxRequestsPerRun: 13 },
      }),
    );
    expect(() => loadCollectorConfig({ configPath: notInt, reload: true })).toThrow(
      /maxCourtsPerRun/,
    );

    const wrongType = writeConfig(
      JSON.stringify({
        ...baseConfig,
        scope: { courts, maxCourtsPerRun: 1, maxRequestsPerRun: "열세 번" },
      }),
    );
    expect(() => loadCollectorConfig({ configPath: wrongType, reload: true })).toThrow(
      /maxRequestsPerRun/,
    );
  });

  it("scope.maxCourtsPerRun/maxRequestsPerRun이 유효하면 정상 로드된다(법원 1곳 기본 설정과 동일한 형태)", () => {
    const file = writeConfig(
      JSON.stringify({
        scope: {
          courts: [{ name: "서울중앙지방법원", courtCode: "B000210" }],
          maxCourtsPerRun: 1,
          maxRequestsPerRun: 13,
        },
        intervalMs: 600000,
        analysis: {
          maxItemsPerRun: 5,
          maxReanalysisPerRun: 2,
          reanalysisCooldownHours: 24,
          intervalMs: 600000,
        },
        photos: VALID_PHOTOS,
        observability: { maxRunsPerWorker: 1000, staleAfterIntervals: 3 },
      }),
    );
    const config = loadCollectorConfig({ configPath: file, reload: true });
    expect(config.scope.maxCourtsPerRun).toBe(1);
    expect(config.scope.maxRequestsPerRun).toBe(13);
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

describe("loadCollectorConfig — photos 절 (fix-photo-worker-and-deploy-config 3.4)", () => {
  it("실제 config/collector.json의 photos 절은 설계 기본값이다", () => {
    const config = loadCollectorConfig({
      configPath: path.resolve(process.cwd(), "config/collector.json"),
      reload: true,
    });
    expect(config.photos).toEqual({
      intervalMs: 1_800_000,
      maxItemsPerRun: 5,
      requestDelayMs: 30_000,
      retryAfterHours: 24,
    });
  });

  it("유효한 photos 절은 그대로 로드된다", () => {
    const config = loadCollectorConfig({ configPath: fullConfig(VALID_PHOTOS), reload: true });
    expect(config.photos).toEqual(VALID_PHOTOS);
  });

  it("photos 절이 통째로 없으면 기본값으로 넘어가지 않고 throw한다", () => {
    expect(() => loadCollectorConfig({ configPath: fullConfig(undefined), reload: true })).toThrow(
      /photos/,
    );
  });

  it.each(["intervalMs", "maxItemsPerRun", "requestDelayMs", "retryAfterHours"] as const)(
    "photos.%s가 없으면 throw한다",
    (key) => {
      const photos: Record<string, number> = { ...VALID_PHOTOS };
      delete photos[key];
      expect(() => loadCollectorConfig({ configPath: fullConfig(photos), reload: true })).toThrow(
        new RegExp(`photos\\.${key}`),
      );
    },
  );

  it.each([
    ["intervalMs", -1],
    ["maxItemsPerRun", 0],
    ["requestDelayMs", -30000],
    ["retryAfterHours", -24],
    ["maxItemsPerRun", 1.5],
    ["requestDelayMs", "30초"],
  ] as const)("photos.%s가 %s이면 throw한다", (key, value) => {
    expect(() =>
      loadCollectorConfig({
        configPath: fullConfig({ ...VALID_PHOTOS, [key]: value }),
        reload: true,
      }),
    ).toThrow(new RegExp(`photos\\.${key}`));
  });
});
