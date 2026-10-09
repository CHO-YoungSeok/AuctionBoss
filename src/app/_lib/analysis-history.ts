/**
 * 물건 상세 화면이 분석 이력(`Analysis[]`)을 "기본 표시할 최신 분석"과 "열람 가능한 이전
 * 분석들"로 나누기 위해 쓰는 순수 헬퍼.
 *
 * spec의 "재분석된 물건 상세" 시나리오(분석이 2건 이상이면 최신을 기본 표시하고 이전 분석
 * 건수·내용을 볼 수 있는 수단을 제공)를 만족하려면 "어디까지가 최신이고 어디부터가
 * 이전인가"를 판정해야 한다. change-history.ts의 선례(기준점/실제 변경 구별이 JSX에
 * 인라인돼 있다가 버그로 발견된 적이 있다)를 따라, 이 판정도 JSX 밖으로 뽑아 테스트로
 * 고정한다.
 */
import type { Analysis } from "@/lib/domain";

export interface AnalysisHistorySplit {
  /** 기본으로 표시할 최신 분석. 분석이 하나도 없으면 `null`. */
  latest: Analysis | null;
  /** 최신을 제외한 나머지, 최신순(가장 최근 것부터). 분석이 0건이나 1건이면 빈 배열. */
  previous: Analysis[];
}

/**
 * `listAnalyses(itemId)`가 반환하는 배열(레포지토리 계약상 `analyzed_at DESC, id DESC`로
 * 이미 정렬돼 있다 — 백엔드의 분석 이력 조회)을 최신 1건과 나머지로
 * 나눈다.
 *
 * 여기서 다시 정렬하지 않는다 — 정렬 기준은 레포지토리의 책임이고 표시 계층은 그 계약을
 * 신뢰한다(직접 정렬하면 두 곳의 정렬 기준이 어긋날 때 조용히 틀린 "최신"을 보여줄 수 있다).
 */
export function splitAnalysisHistory(
  analyses: readonly Analysis[],
): AnalysisHistorySplit {
  if (analyses.length === 0) return { latest: null, previous: [] };
  const [latest, ...previous] = analyses;
  return { latest, previous };
}
