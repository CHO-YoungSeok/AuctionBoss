/**
 * 목록 상단 데이터 신선도·분석 커버리지 배너의 표시 판단 (ux-overhaul-phase1
 * design.md D6, tasks.md 7.1~7.2).
 *
 * 분석이 전체의 1.3%뿐인데 목록 어디에도 그 사실이 없어 사용자가 상세를 열어봐야
 * 알 수 있었다. 그리고 수집이 차단·정지 상태여도(1시간 백오프 등) 목록은 아무 일
 * 없다는 얼굴로 낡은 가격을 계속 보여준다 — 이 헬퍼가 그 두 가지를 드러낸다.
 *
 * design.md D6: `getWorkerStatus`(이미 `/status`가 쓰는 함수)를 **재사용**한다 — 새로
 * 구현하지 않는다. 이 파일은 그 결과를 화면이 쓰기 좋은 모양으로만 정리한다.
 */
import type {
  CollectorRunDetail,
  WorkerRunDetail,
  WorkerStatus,
  WorkerStatusState,
} from "@/lib/domain";

export interface CollectionBannerData {
  /** `getWorkerStatus("collector").lastSuccessAt` 그대로 — 마지막 수집 성공 시각. */
  lastCollectedAt: string | null;
  /** 가장 최근 collector 회차가 대상으로 삼은 법원 이름들. 알 수 없으면 빈 배열. */
  targetCourts: string[];
  /** `listItems({analyzed:true}).total` — 새 쿼리를 만들지 않는다(tasks.md 7.4). */
  analyzedCount: number;
  /** `listItems({}).total`(필터 없는 전체 건수). */
  totalCount: number;
  /** collector의 현재 상태. `blocked`/`stale`이면 화면이 경고를 띄운다(tasks.md 7.2). */
  collectorState: WorkerStatusState;
}

function hasTargetCourts(detail: WorkerRunDetail | null): detail is CollectorRunDetail {
  return detail !== null && "targetCourts" in detail;
}

/**
 * `getWorkerStatus("collector", ...)` 결과와 이미 알고 있는 건수(analyzed/total)를 배너에
 * 필요한 모양으로 정리한다. `detail`은 `running`/`skipped`처럼 detail이 없는 회차일 수도
 * 있으므로(`WorkerRun.detail`은 nullable) 대상 법원을 못 구하면 빈 배열로 둔다 — 지어내지
 * 않는다.
 */
export function buildCollectionBanner(params: {
  collectorStatus: WorkerStatus;
  analyzedCount: number;
  totalCount: number;
}): CollectionBannerData {
  const { collectorStatus, analyzedCount, totalCount } = params;
  const detail = collectorStatus.lastRun?.detail ?? null;
  const targetCourts = hasTargetCourts(detail) ? detail.targetCourts : [];

  return {
    lastCollectedAt: collectorStatus.lastSuccessAt,
    targetCourts,
    analyzedCount,
    totalCount,
    collectorState: collectorStatus.state,
  };
}

/** 커버리지 문구: `"분석 5/389건"`. */
export function formatCoverage(data: Pick<CollectionBannerData, "analyzedCount" | "totalCount">): string {
  return `분석 ${data.analyzedCount.toLocaleString("ko-KR")}/${data.totalCount.toLocaleString("ko-KR")}건`;
}

/** 목록에서 경고 배너를 띄워야 하는지(tasks.md 7.2) — 수집이 차단되었거나 정지됐을 때. */
export function shouldWarnCollection(state: WorkerStatusState): boolean {
  return state === "blocked" || state === "stale";
}
