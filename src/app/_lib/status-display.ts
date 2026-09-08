/**
 * `/status` 페이지의 표시 판단 순수 헬퍼(task 5.2).
 *
 * 왜 별도 파일인가: 이전 사이클에서 표시 판단을 JSX 안에 인라인으로 두었다가 실제 버그로
 * 이어진 적이 있다(`analyzed` 필터가 `hasActiveFilters`에서 빠져 화면 안내가 틀렸던 사례,
 * `src/lib/domain/item-query.ts` 참고). 상태 → 라벨/심각도 매핑, 소요시간 포맷, 성공률의
 * null-vs-0 표시 같은 판단을 여기 순수 함수로 뽑아 테스트로 고정한다.
 *
 * design.md D5가 상태의 **뜻**을 정했으므로 라벨도 그 뜻을 그대로 옮긴다 — 특히 `stale`은
 * "idle"(한가함)이 아니라 "최근 기록이 없어 워커가 죽었을 수 있음"이다. 이걸 "대기 중" 같은
 * 말로 쓰면 죽은 워커를 건강한 것처럼 보여주는 거짓 안내가 된다.
 */
import type {
  AnalyzerRunDetail,
  CollectorRunDetail,
  RunOutcome,
  SkipReason,
  WorkerKind,
  WorkerRun,
  WorkerStatusState,
} from "@/lib/domain";

/** 워커 상태(`WorkerStatusState`)의 심각도. CSS 클래스 이름으로도 그대로 쓴다
 * (`status-badge status-{severity}`). `blocked`를 별도 값으로 두는 이유: 스펙이 차단을
 * 눈에 띄게 구별하라고 요구하므로, `failed`/`stale`과 같은 색으로 묶이면 안 된다. */
export type WorkerStateSeverity = "ok" | "blocked" | "failed" | "stale";

export interface WorkerStateDisplay {
  label: string;
  severity: WorkerStateSeverity;
  /** 이 상태가 실제로 뜻하는 바를 사람이 읽을 문장으로. */
  description: string;
}

const WORKER_STATE_DISPLAY: Record<WorkerStatusState, WorkerStateDisplay> = {
  ok: {
    label: "정상",
    severity: "ok",
    description: "최근 성공한 회차가 있습니다.",
  },
  blocked: {
    label: "차단됨",
    severity: "blocked",
    description: "로봇탐지·차단으로 가장 최근 완료된 회차가 중단되었습니다. 확인이 필요합니다.",
  },
  failed: {
    label: "실패",
    severity: "failed",
    description: "가장 최근 완료된 회차가 오류로 실패했습니다.",
  },
  stale: {
    label: "미실행",
    severity: "stale",
    description:
      "기대 주기의 여러 배 동안 실행 기록이 없습니다 — 워커가 멈췄거나 죽었을 수 있습니다.",
  },
};

/** design.md D5의 상태 값을 화면 라벨·심각도·설명으로 바꾼다. */
export function describeWorkerState(state: WorkerStatusState): WorkerStateDisplay {
  return WORKER_STATE_DISPLAY[state];
}

/** 워커 종류의 화면 표시 이름. */
export const WORKER_LABELS: Record<WorkerKind, string> = {
  collector: "수집",
  analyzer: "분석",
};

/** `RunsSummary.successRate`(성공률)를 표시 문자열로. `null`은 "완료된 회차가 아직
 * 없다"는 뜻이라 "0%"와 절대 같은 문자열을 쓰면 안 된다(스펙 요구사항). */
export function formatSuccessRate(rate: number | null): string {
  if (rate === null) return "기록 없음";
  return `${Math.round(rate * 100)}%`;
}

/** 회차 한 건의 결과 구분(`RunOutcome`) 표시. */
export type RunOutcomeSeverity = "ok" | "warning" | "danger" | "neutral";

export interface RunOutcomeDisplay {
  label: string;
  severity: RunOutcomeSeverity;
}

const RUN_OUTCOME_DISPLAY: Record<RunOutcome, RunOutcomeDisplay> = {
  running: { label: "진행 중", severity: "neutral" },
  success: { label: "성공", severity: "ok" },
  failed: { label: "실패", severity: "warning" },
  blocked: { label: "차단", severity: "danger" },
  skipped: { label: "건너뜀", severity: "neutral" },
};

export function describeOutcome(outcome: RunOutcome): RunOutcomeDisplay {
  return RUN_OUTCOME_DISPLAY[outcome];
}

const SKIP_REASON_LABELS: Record<SkipReason, string> = {
  overlap: "중첩 실행 방지 — 이전 회차가 아직 진행 중이었음",
  backoff: "차단 백오프 진행 중",
};

/** `skipped` 회차의 사유(`error_kind`에 저장됨)를 사람이 읽는 문장으로. 알 수 없는
 * 값(스키마 확장 등)은 원문을 그대로 보여준다 — 조용히 숨기지 않는다. */
export function describeSkipReason(reason: string | null): string {
  if (reason === null) return "사유 없음";
  if (reason === "overlap" || reason === "backoff") return SKIP_REASON_LABELS[reason];
  return reason;
}

/** 회차의 시작·종료 시각으로 소요 시간을 사람이 읽는 문자열로 만든다.
 * 아직 끝나지 않은 회차(`finishedAt === null`)는 `now` 기준 경과 시간을 보여주고
 * "진행 중"임을 함께 표시한다 — 화면이 실제로는 안 끝난 회차를 완료된 것처럼 보이게
 * 하면 안 된다. */
export function formatRunDuration(
  startedAt: string,
  finishedAt: string | null,
  now: Date = new Date(),
): string {
  const startMs = new Date(startedAt).getTime();
  if (!Number.isFinite(startMs)) return "-";

  if (finishedAt === null) {
    const elapsedMs = now.getTime() - startMs;
    if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return "진행 중";
    return `${formatMs(elapsedMs)} 경과 (진행 중)`;
  }

  const finishMs = new Date(finishedAt).getTime();
  if (!Number.isFinite(finishMs)) return "-";
  const durationMs = finishMs - startMs;
  if (durationMs < 0) return "-";
  return formatMs(durationMs);
}

function formatMs(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}초`;

  const totalMinutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (totalMinutes < 60) {
    return seconds > 0 ? `${totalMinutes}분 ${seconds}초` : `${totalMinutes}분`;
  }

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes > 0 ? `${hours}시간 ${minutes}분` : `${hours}시간`;
}

function isCollectorDetail(
  worker: WorkerKind,
  detail: WorkerRun["detail"],
): detail is CollectorRunDetail {
  return worker === "collector" && detail !== null;
}

function isAnalyzerDetail(
  worker: WorkerKind,
  detail: WorkerRun["detail"],
): detail is AnalyzerRunDetail {
  return worker === "analyzer" && detail !== null;
}

/**
 * 회차 한 건의 "상세" 열에 보여줄 문자열을 결정한다(task 5.2 요구사항 전부):
 * - `skipped`는 사유(overlap/backoff)
 * - `failed`/`blocked`는 오류 종류 + 메시지
 * - `success`인 collector 회차는 신규/갱신/변경 건수 — `changed`가 스펙 상 운영자의
 *   가짜 변경 신호이므로 반드시 보이게 한다(archived add-price-change-history 참고)
 * - `success`인 analyzer 회차는 신규/재분석/성공/실패 건수
 * - 그 외(`running` 등)는 "-"
 */
export function describeRunDetail(run: WorkerRun): string {
  if (run.outcome === "skipped") return describeSkipReason(run.errorKind);

  if (run.outcome === "failed" || run.outcome === "blocked") {
    const kind = run.errorKind ?? "알 수 없는 오류";
    return run.errorMessage ? `${kind}: ${run.errorMessage}` : kind;
  }

  if (run.outcome === "success") {
    if (isCollectorDetail(run.worker, run.detail)) {
      const d = run.detail;
      return `신규 ${d.inserted} · 갱신 ${d.updated} · 변경 ${d.changed}`;
    }
    if (isAnalyzerDetail(run.worker, run.detail)) {
      const d = run.detail;
      return `신규분석 ${d.newCount} · 재분석 ${d.reanalysisCount} · 성공 ${d.succeeded} · 실패 ${d.failed}`;
    }
  }

  return "-";
}
