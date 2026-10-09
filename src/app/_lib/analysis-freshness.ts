/**
 * 물건 상세 화면의 분석 최신성 상태(대기 중 / 최신 / 갱신 예정) 판정 (design.md D3,
 * tasks.md 3.1~3.2).
 *
 * **재분석 대상 선정과 같은 규칙을 재사용한다.** 판정 로직을 여기서 새로 만들면 이
 * 화면과 워커(백엔드의 재분석 후보 조건(`ItemSearchRepositoryTest`의 `needsAnalysis*`가 증명))가 다른 답을 낼 수
 * 있다 — 그게 이 파일이 그 SQL 조건과 정확히 같은 두 갈래(조건 1: 최신 분석 이후 실제
 * 변경 / 조건 2: 프롬프트 버전이 다름)로 판정하는 이유다:
 *
 * 1) 분석이 아예 없으면 → "pending"(대기 중)
 * 2) 분석은 있고, 최신 분석 이후 실제 변경(`kind === "change"`, 기준점 제외)이 있거나
 *    최신 분석의 `promptVersion`이 현재 `PROMPT_VERSION`과 다르면 → "stale"(갱신 예정)
 * 3) 그 외(분석 있고 변경 없고 버전도 같음) → "fresh"(최신)
 *
 * **쿨다운은 이 판정에 넣지 않는다.** `NEEDS_ANALYSIS_PREDICATE`는 쿨다운 중인 물건을
 * 재분석 "후보 목록"에서 제외하지만, 그건 워커가 이번 회차에 그 물건을 집어들지 여부일
 * 뿐 분석이 최신인지와는 다른 질문이다. 최저가가 떨어진 직후라도 쿨다운 중이면 분석은
 * 여전히 옛 값 기준이고, 사용자에게는 그 사실이 그대로 경고돼야 한다(design.md D3 —
 * "최저가가 30% 떨어진 뒤에도 옛 가격 기준 분석이 남아 있으면 틀린 정보"). 쿨다운까지
 * 반영하면 쿨다운 중에는 "최신"으로 보여 정확히 그 사고가 재현된다.
 *
 * 비교는 `>`(초과)를 쓴다 — `NEEDS_ANALYSIS_PREDICATE`와 같은 이유(경계 포함이면 분석
 * 직후의 자기 자신 이력까지 갱신 예정으로 오판할 수 있다)로 `changedAt`이 `analyzedAt`과
 * 같은 시각이면 이미 그 분석에 반영됐다고 본다. ISO 8601 문자열의 사전식 비교가 시간
 * 순서와 같다는 전제는 이 프로젝트가 `changed_at`/`analyzed_at` 비교에 이미 쓰는 방식과
 * 동일하다.
 */
import type { Analysis, ItemChange } from "@/lib/domain";

import { isRealChange } from "./change-history";

export type AnalysisFreshness = "pending" | "fresh" | "stale";

/**
 * 상태별 배지 라벨. **색에만 의존하지 않는다** — 이 텍스트가 상태를 구별하는 주된
 * 수단이다. `Record`로 정의해 상태를 추가하면 컴파일이 깨지게 한다.
 */
export const ANALYSIS_FRESHNESS_LABELS: Record<AnalysisFreshness, string> = {
  pending: "분석 대기 중",
  fresh: "최신 분석",
  stale: "갱신 예정",
};

/**
 * 배지 옆에 붙이는 한 줄 설명. "갱신 예정"은 표시 중인 분석이 현재 값 기준이 아닐 수
 * 있다는 경고로 읽히게 문구를 쓴다(tasks.md 3.2) — 단순히 "오래됨"이 아니라 "지금 보는
 * 내용이 틀렸을 수 있다"는 뜻을 명시한다.
 */
export const ANALYSIS_FRESHNESS_DESCRIPTIONS: Record<AnalysisFreshness, string> = {
  pending: "아직 이 물건은 분석되지 않았습니다.",
  fresh: "물건 정보가 바뀌지 않았거나 마지막 분석 이후 값이 그대로입니다.",
  stale:
    "분석 이후 물건 정보가 바뀌었거나 분석 기준이 낡았습니다 — 아래 분석 내용이 현재 값과 다를 수 있습니다.",
};

/** 판정에 필요한 최신 분석 정보. `Analysis`의 부분집합. */
export type LatestAnalysisFields = Pick<Analysis, "analyzedAt" | "promptVersion">;

/**
 * 분석 최신성 상태를 판정한다.
 *
 * @param latestAnalysis 물건의 최신 분석. 분석이 없으면 `null`.
 * @param changes 물건의 전체 변경 이력(기준점 포함해도 무방 — `isRealChange`로 여기서
 *   실제 변경만 걸러낸다). `repository.listItemChanges(itemId)`의 결과를 그대로 넘기면 된다.
 * @param currentPromptVersion 비교 기준이 되는 현재 프롬프트 버전
 *   (`src/lib/domain/analysis.ts`의 `PROMPT_VERSION`, 워커가 실제로 쓰는 값과 동일).
 */
/**
 * 분석 화면에 상설로 고지하는 소스 한계 문구(ux-overhaul-phase1 design.md, tasks.md 7.3,
 * spec: "소스 한계 고지"). 이 프로젝트의 데이터 소스(법원경매정보)는 권리관계·임차인·
 * 등기 정보를 제공하지 않는다 — README가 이미 "사람이 반드시 알아야 하는 상한선"이라고
 * 적어 둔 사실인데, 화면 어디에도 그 사실이 없었다. 분석 본문만 읽은 사용자가 그것을
 * 권리분석까지 포함한 결과로 오해해서는 안 된다(spec, MUST NOT).
 */
export const SOURCE_LIMITATION_NOTICE =
  "이 분석은 법원경매정보가 제공하는 물건 정보만을 근거로 합니다. 권리관계·임차인·등기 정보는 이 데이터 소스에 포함되어 있지 않으므로, 이 분석에도 반영되어 있지 않습니다. 입찰 전 반드시 별도로 권리분석을 확인하세요.";

export function determineAnalysisFreshness(
  latestAnalysis: LatestAnalysisFields | null,
  changes: readonly Pick<ItemChange, "kind" | "changedAt">[],
  currentPromptVersion: string,
): AnalysisFreshness {
  if (latestAnalysis === null) return "pending";

  const changedSinceAnalysis = changes.some(
    (change) => isRealChange(change) && change.changedAt > latestAnalysis.analyzedAt,
  );
  if (changedSinceAnalysis) return "stale";

  if (latestAnalysis.promptVersion !== currentPromptVersion) return "stale";

  return "fresh";
}
