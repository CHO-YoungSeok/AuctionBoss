import { describe, expect, it } from "vitest";

import type { ItemChange } from "@/lib/domain";

import {
  ANALYSIS_FRESHNESS_DESCRIPTIONS,
  ANALYSIS_FRESHNESS_LABELS,
  determineAnalysisFreshness,
  type AnalysisFreshness,
} from "../analysis-freshness";

const CURRENT_PROMPT_VERSION = "v3";

function baseline(overrides: Partial<ItemChange> = {}): ItemChange {
  return {
    id: 1,
    itemId: 1,
    field: "minBidPrice",
    oldValue: null,
    newValue: "1000000000",
    changedAt: "2026-01-01T00:00:00.000Z",
    kind: "baseline",
    ...overrides,
  };
}

function realChange(overrides: Partial<ItemChange> = {}): ItemChange {
  return {
    id: 2,
    itemId: 1,
    field: "minBidPrice",
    oldValue: "1000000000",
    newValue: "800000000",
    changedAt: "2026-01-02T00:00:00.000Z",
    kind: "change",
    ...overrides,
  };
}

describe("determineAnalysisFreshness", () => {
  it("분석이 없으면 pending(대기 중) — tasks.md 3.3 case 1", () => {
    const result = determineAnalysisFreshness(null, [], CURRENT_PROMPT_VERSION);
    expect(result).toBe("pending");
  });

  it("분석 후 변경 없고 프롬프트 버전도 같으면 fresh(최신) — tasks.md 3.3 case 2", () => {
    const latest = { analyzedAt: "2026-01-05T00:00:00.000Z", promptVersion: CURRENT_PROMPT_VERSION };
    const changes = [baseline({ changedAt: "2026-01-01T00:00:00.000Z" })];
    expect(determineAnalysisFreshness(latest, changes, CURRENT_PROMPT_VERSION)).toBe("fresh");
  });

  it("변경 이력이 아예 없어도(레거시 물건) 분석이 있으면 fresh", () => {
    const latest = { analyzedAt: "2026-01-05T00:00:00.000Z", promptVersion: CURRENT_PROMPT_VERSION };
    expect(determineAnalysisFreshness(latest, [], CURRENT_PROMPT_VERSION)).toBe("fresh");
  });

  it("분석 후 감시 필드가 변경되면 stale(갱신 예정) — tasks.md 3.3 case 3", () => {
    const latest = { analyzedAt: "2026-01-01T00:00:00.000Z", promptVersion: CURRENT_PROMPT_VERSION };
    const changes = [realChange({ changedAt: "2026-01-02T00:00:00.000Z" })];
    expect(determineAnalysisFreshness(latest, changes, CURRENT_PROMPT_VERSION)).toBe("stale");
  });

  it("분석 후 프롬프트 버전이 다르면 stale(갱신 예정) — tasks.md 3.3 case 4", () => {
    const latest = { analyzedAt: "2026-01-05T00:00:00.000Z", promptVersion: "v2" };
    expect(determineAnalysisFreshness(latest, [], CURRENT_PROMPT_VERSION)).toBe("stale");
  });

  it("변경이 분석 시각과 같거나 그 이전이면 반영된 것으로 보고 stale 처리하지 않는다(경계 제외)", () => {
    const latest = { analyzedAt: "2026-01-02T00:00:00.000Z", promptVersion: CURRENT_PROMPT_VERSION };
    const sameInstant = realChange({ changedAt: "2026-01-02T00:00:00.000Z" });
    const before = realChange({ changedAt: "2026-01-01T00:00:00.000Z" });
    expect(determineAnalysisFreshness(latest, [sameInstant, before], CURRENT_PROMPT_VERSION)).toBe(
      "fresh",
    );
  });

  it("기준점(kind: baseline)만 최신 분석 이후에 있어도 stale로 보지 않는다 — 실제 변경만 본다", () => {
    const latest = { analyzedAt: "2026-01-01T00:00:00.000Z", promptVersion: CURRENT_PROMPT_VERSION };
    const changes = [baseline({ changedAt: "2026-01-05T00:00:00.000Z" })];
    expect(determineAnalysisFreshness(latest, changes, CURRENT_PROMPT_VERSION)).toBe("fresh");
  });

  it("변경과 프롬프트 버전 불일치가 동시에 있어도 stale 하나로 수렴한다", () => {
    const latest = { analyzedAt: "2026-01-01T00:00:00.000Z", promptVersion: "v2" };
    const changes = [realChange({ changedAt: "2026-01-02T00:00:00.000Z" })];
    expect(determineAnalysisFreshness(latest, changes, CURRENT_PROMPT_VERSION)).toBe("stale");
  });

  it("모든 상태에 텍스트 라벨과 설명이 있다 — 색에만 의존하지 않는다", () => {
    const states: AnalysisFreshness[] = ["pending", "fresh", "stale"];
    for (const state of states) {
      expect(ANALYSIS_FRESHNESS_LABELS[state].length).toBeGreaterThan(0);
      expect(ANALYSIS_FRESHNESS_DESCRIPTIONS[state].length).toBeGreaterThan(0);
    }
  });

  it("stale 설명 문구는 '현재 값 기준이 아닐 수 있다'는 경고를 담는다", () => {
    expect(ANALYSIS_FRESHNESS_DESCRIPTIONS.stale).toMatch(/다를 수 있습니다|기준이 아닐 수/);
  });
});
