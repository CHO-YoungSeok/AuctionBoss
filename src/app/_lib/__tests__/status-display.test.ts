/**
 * `/status` 표시 판단 헬퍼 테스트(task 5.2). 표시 판단을 JSX에서 뽑아낸 이유가 바로 이
 * 테스트다 — `analyzed` 필터 누락처럼 판단 하나가 조용히 틀려도 화면만 봐서는 못 잡는다.
 */
import { describe, expect, it } from "vitest";

import type { AnalyzerRunDetail, CollectorRunDetail, WorkerRun } from "@/lib/domain";

import {
  describeOutcome,
  describeRunDetail,
  describeSkipReason,
  describeWorkerState,
  formatRunDuration,
  formatSuccessRate,
} from "../status-display";

function makeRun(overrides: Partial<WorkerRun> = {}): WorkerRun {
  return {
    id: 1,
    worker: "collector",
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:01:00.000Z",
    outcome: "success",
    errorKind: null,
    errorMessage: null,
    detail: null,
    itemsChanged: null,
    ...overrides,
  };
}

describe("describeWorkerState", () => {
  it("stale을 '미실행'으로 표시하되 '워커가 죽었을 수 있다'는 설명을 포함한다 — '대기 중' 같은 건강한 뉘앙스가 아니어야 한다", () => {
    const display = describeWorkerState("stale");
    expect(display.label).not.toMatch(/대기|idle|한가/i);
    expect(display.description).toMatch(/멈췄|죽었/);
    expect(display.severity).toBe("stale");
  });

  it("blocked는 별도의 severity(blocked)를 가진다 — failed/stale과 같은 색으로 묶이면 안 된다", () => {
    const display = describeWorkerState("blocked");
    expect(display.severity).toBe("blocked");
    expect(display.severity).not.toBe("failed");
    expect(display.severity).not.toBe("stale");
  });

  it("ok/failed도 각각 고유한 라벨과 severity를 가진다", () => {
    expect(describeWorkerState("ok").severity).toBe("ok");
    expect(describeWorkerState("failed").severity).toBe("failed");
  });
});

describe("formatSuccessRate", () => {
  it("null은 '기록 없음'이지 '0%'가 아니다 — 완료된 회차가 아예 없다는 뜻", () => {
    expect(formatSuccessRate(null)).toBe("기록 없음");
    expect(formatSuccessRate(null)).not.toMatch(/0%/);
  });

  it("실제 0%는 그대로 0%로 표시한다(null과 구분)", () => {
    expect(formatSuccessRate(0)).toBe("0%");
  });

  it("소수 성공률은 반올림한 퍼센트로 표시한다", () => {
    expect(formatSuccessRate(1)).toBe("100%");
    expect(formatSuccessRate(0.5)).toBe("50%");
    expect(formatSuccessRate(1 / 3)).toBe("33%");
  });
});

describe("describeOutcome", () => {
  it("blocked는 danger, success는 ok, failed는 warning severity를 가진다", () => {
    expect(describeOutcome("blocked").severity).toBe("danger");
    expect(describeOutcome("success").severity).toBe("ok");
    expect(describeOutcome("failed").severity).toBe("warning");
    expect(describeOutcome("skipped").severity).toBe("neutral");
    expect(describeOutcome("running").severity).toBe("neutral");
  });
});

describe("describeSkipReason", () => {
  it("overlap과 backoff을 서로 다른 문장으로 구별한다", () => {
    const overlap = describeSkipReason("overlap");
    const backoff = describeSkipReason("backoff");
    expect(overlap).not.toBe(backoff);
    expect(overlap).toMatch(/이전 회차|진행 중/);
    expect(backoff).toMatch(/백오프/);
  });

  it("알 수 없는 사유 문자열은 원문을 그대로 보여준다(조용히 숨기지 않는다)", () => {
    expect(describeSkipReason("future-reason")).toBe("future-reason");
  });

  it("null은 '사유 없음'이다", () => {
    expect(describeSkipReason(null)).toBe("사유 없음");
  });
});

describe("formatRunDuration", () => {
  it("60초 미만은 초 단위로 표시한다", () => {
    expect(
      formatRunDuration("2026-01-01T00:00:00.000Z", "2026-01-01T00:00:45.000Z"),
    ).toBe("45초");
  });

  it("분·초 단위를 함께 표시한다", () => {
    expect(
      formatRunDuration("2026-01-01T00:00:00.000Z", "2026-01-01T00:03:12.000Z"),
    ).toBe("3분 12초");
  });

  it("시간·분 단위를 함께 표시한다", () => {
    expect(
      formatRunDuration("2026-01-01T00:00:00.000Z", "2026-01-01T01:05:00.000Z"),
    ).toBe("1시간 5분");
  });

  it("아직 끝나지 않은 회차(finishedAt null)는 경과 시간과 함께 '진행 중'을 명시한다 — 끝난 것처럼 보이면 안 된다", () => {
    const result = formatRunDuration(
      "2026-01-01T00:00:00.000Z",
      null,
      new Date("2026-01-01T00:02:00.000Z"),
    );
    expect(result).toMatch(/진행 중/);
    expect(result).toMatch(/2분/);
  });
});

describe("describeRunDetail", () => {
  it("skipped 회차는 사유를 보여준다", () => {
    const run = makeRun({ outcome: "skipped", errorKind: "overlap", finishedAt: "2026-01-01T00:00:00.000Z" });
    expect(describeRunDetail(run)).toMatch(/이전 회차|진행 중/);
  });

  it("failed 회차는 오류 종류와 메시지를 함께 보여준다", () => {
    const run = makeRun({
      outcome: "failed",
      errorKind: "ResponseSchemaError",
      errorMessage: "필드 누락: usageType",
    });
    const result = describeRunDetail(run);
    expect(result).toContain("ResponseSchemaError");
    expect(result).toContain("필드 누락: usageType");
  });

  it("blocked 회차는 오류 종류를 보여준다(메시지가 없어도 종류는 반드시 보인다)", () => {
    const run = makeRun({ outcome: "blocked", errorKind: "RobotDetectedError", errorMessage: null });
    expect(describeRunDetail(run)).toBe("RobotDetectedError");
  });

  it("collector 성공 회차는 신규/갱신/변경 건수를 전부 보여준다 — changed는 가짜 변경 탐지의 핵심 신호", () => {
    const detail: CollectorRunDetail = {
      targetCourts: ["서울중앙지방법원"],
      pagesRequested: 3,
      itemsFetched: 30,
      inserted: 5,
      updated: 20,
      changed: 7,
    };
    const run = makeRun({ outcome: "success", worker: "collector", detail });
    const result = describeRunDetail(run);
    expect(result).toContain("신규 5");
    expect(result).toContain("갱신 20");
    expect(result).toContain("변경 7");
  });

  it("analyzer 성공 회차는 신규분석/재분석/성공/실패 건수를 보여준다", () => {
    const detail: AnalyzerRunDetail = { newCount: 2, reanalysisCount: 1, succeeded: 3, failed: 0 };
    const run = makeRun({ outcome: "success", worker: "analyzer", detail });
    const result = describeRunDetail(run);
    expect(result).toContain("신규분석 2");
    expect(result).toContain("재분석 1");
    expect(result).toContain("성공 3");
    expect(result).toContain("실패 0");
  });

  it("진행 중(running) 회차는 '-'를 보여준다", () => {
    const run = makeRun({ outcome: "running", finishedAt: null, detail: null });
    expect(describeRunDetail(run)).toBe("-");
  });

  it("detail이 없는 성공 회차는 '-'를 보여준다(방어적 처리)", () => {
    const run = makeRun({ outcome: "success", detail: null });
    expect(describeRunDetail(run)).toBe("-");
  });
});
