import { describe, expect, it } from "vitest";

import type { CollectorRunDetail, WorkerRun, WorkerStatus } from "@/lib/domain";

import { buildCollectionBanner, formatCoverage, shouldWarnCollection } from "../collection-banner";

function makeCollectorDetail(overrides: Partial<CollectorRunDetail> = {}): CollectorRunDetail {
  return {
    targetCourts: ["서울중앙지방법원"],
    pagesRequested: 1,
    itemsFetched: 10,
    inserted: 1,
    updated: 9,
    changed: 2,
    ...overrides,
  };
}

function makeRun(overrides: Partial<WorkerRun> = {}): WorkerRun {
  return {
    id: 1,
    worker: "collector",
    startedAt: "2026-09-08T00:00:00.000Z",
    finishedAt: "2026-09-08T00:01:00.000Z",
    outcome: "success",
    errorKind: null,
    errorMessage: null,
    detail: null,
    itemsChanged: null,
    ...overrides,
  };
}

function makeStatus(overrides: Partial<WorkerStatus> = {}): WorkerStatus {
  return {
    state: "ok",
    lastSuccessAt: "2026-09-08T00:01:00.000Z",
    lastRun: null,
    ...overrides,
  };
}

describe("buildCollectionBanner", () => {
  it("마지막 수집 성공 시각을 그대로 옮긴다", () => {
    const data = buildCollectionBanner({
      collectorStatus: makeStatus({ lastSuccessAt: "2026-09-08T01:00:00.000Z" }),
      analyzedCount: 5,
      totalCount: 389,
    });
    expect(data.lastCollectedAt).toBe("2026-09-08T01:00:00.000Z");
  });

  it("최근 collector 회차의 대상 법원을 옮긴다", () => {
    const data = buildCollectionBanner({
      collectorStatus: makeStatus({
        lastRun: makeRun({ detail: makeCollectorDetail({ targetCourts: ["인천지방법원", "수원지방법원"] }) }),
      }),
      analyzedCount: 5,
      totalCount: 389,
    });
    expect(data.targetCourts).toEqual(["인천지방법원", "수원지방법원"]);
  });

  it("lastRun이 없으면 대상 법원은 빈 배열(지어내지 않는다)", () => {
    const data = buildCollectionBanner({
      collectorStatus: makeStatus({ lastRun: null }),
      analyzedCount: 0,
      totalCount: 389,
    });
    expect(data.targetCourts).toEqual([]);
  });

  it("detail이 null인 회차(running/skipped)는 대상 법원이 빈 배열", () => {
    const data = buildCollectionBanner({
      collectorStatus: makeStatus({ lastRun: makeRun({ outcome: "skipped", detail: null }) }),
      analyzedCount: 0,
      totalCount: 389,
    });
    expect(data.targetCourts).toEqual([]);
  });

  it("analyzedCount·totalCount·collectorState를 그대로 옮긴다", () => {
    const data = buildCollectionBanner({
      collectorStatus: makeStatus({ state: "blocked" }),
      analyzedCount: 5,
      totalCount: 389,
    });
    expect(data.analyzedCount).toBe(5);
    expect(data.totalCount).toBe(389);
    expect(data.collectorState).toBe("blocked");
  });
});

describe("formatCoverage", () => {
  it("실측 사례 그대로 '분석 5/389건'", () => {
    expect(formatCoverage({ analyzedCount: 5, totalCount: 389 })).toBe("분석 5/389건");
  });

  it("0건이어도 오류 없이 표시된다", () => {
    expect(formatCoverage({ analyzedCount: 0, totalCount: 0 })).toBe("분석 0/0건");
  });
});

describe("shouldWarnCollection", () => {
  it("blocked면 경고", () => {
    expect(shouldWarnCollection("blocked")).toBe(true);
  });

  it("stale이면 경고", () => {
    expect(shouldWarnCollection("stale")).toBe(true);
  });

  it("ok면 경고 아님", () => {
    expect(shouldWarnCollection("ok")).toBe(false);
  });

  it("failed면 경고 아님 — 이 배너는 수집 차단·정지만 경고한다(tasks.md 7.2)", () => {
    expect(shouldWarnCollection("failed")).toBe(false);
  });
});
