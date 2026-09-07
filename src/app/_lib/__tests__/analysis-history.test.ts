/**
 * `analysis-history.ts`의 순수 헬퍼 테스트.
 *
 * "분석이 몇 건이면 이전 분석 섹션을 보여줄지"는 화면 표시 규칙의 핵심이라 특히 경계값
 * (0건/1건/2건 이상)을 두텁게 고정한다 — 1건일 때 빈 "이전 분석" 섹션이 보이는 것은
 * spec이 명시적으로 금지하는 버그다.
 */
import { describe, expect, it } from "vitest";

import type { Analysis } from "@/lib/domain";

import { splitAnalysisHistory } from "../analysis-history";

function analysis(overrides: Partial<Analysis>): Analysis {
  return {
    id: 1,
    itemId: 1,
    body: "본문",
    model: null,
    promptVersion: "v1",
    analyzedAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("splitAnalysisHistory", () => {
  it("분석이 0건이면 latest는 null, previous는 빈 배열", () => {
    expect(splitAnalysisHistory([])).toEqual({ latest: null, previous: [] });
  });

  it("분석이 1건이면 latest에만 들어가고 previous는 빈 배열이어야 한다(빈 '이전 분석' 섹션 방지)", () => {
    const only = analysis({ id: 1 });
    expect(splitAnalysisHistory([only])).toEqual({ latest: only, previous: [] });
  });

  it("분석이 2건이면 배열의 첫 항목(최신)이 latest, 나머지가 previous", () => {
    const newest = analysis({ id: 2, analyzedAt: "2026-09-05T00:00:00.000Z" });
    const older = analysis({ id: 1, analyzedAt: "2026-09-01T00:00:00.000Z" });
    // listAnalyses 계약: 이미 analyzed_at DESC, id DESC로 정렬돼 배열로 들어온다.
    expect(splitAnalysisHistory([newest, older])).toEqual({
      latest: newest,
      previous: [older],
    });
  });

  it("분석이 3건이면 최신 1건만 latest, 나머지 2건이 previous에 입력 순서대로 남는다", () => {
    const a3 = analysis({ id: 3, analyzedAt: "2026-09-06T00:00:00.000Z" });
    const a2 = analysis({ id: 2, analyzedAt: "2026-09-03T00:00:00.000Z" });
    const a1 = analysis({ id: 1, analyzedAt: "2026-09-01T00:00:00.000Z" });
    expect(splitAnalysisHistory([a3, a2, a1])).toEqual({
      latest: a3,
      previous: [a2, a1],
    });
  });

  it("입력 배열을 변형하지 않는다", () => {
    const list = [analysis({ id: 2 }), analysis({ id: 1 })];
    const copy = [...list];
    splitAnalysisHistory(list);
    expect(list).toEqual(copy);
  });
});
