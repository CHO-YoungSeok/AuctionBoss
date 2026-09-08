/**
 * 워커 상태 화면(`/status`, design.md D7, 스펙 "상태 화면").
 *
 * 기존 페이지들과 같은 관례를 따른다: 서버 컴포넌트에서 저장소를 직접 호출하고
 * (`getWorkerStatus`/`listWorkerRuns`/`summarizeRuns`), `force-dynamic`으로 정적
 * 프리렌더를 끈다 — 워커가 새로 남긴 회차가 바로 보여야 한다.
 *
 * 표시 판단(상태 → 라벨/심각도, 소요시간 포맷, null-vs-0 성공률)은 전부
 * `../_lib/status-display.ts`의 순수 함수로 뽑혀 있고 이 파일은 그 결과를 그대로
 * 렌더링만 한다 — 판단을 JSX에 인라인으로 두면 테스트로 못 잡는 사례가 이 프로젝트에
 * 실제로 있었다(`hasActiveFilters` 누락 버그, `src/lib/domain/item-query.ts` 참고).
 */
import Link from "next/link";

import {
  COLLECTOR_STATE_KEYS,
  getCollectorState,
  getUnreadCount,
  getWorkerStatus,
  listWorkerRuns,
  summarizeRuns,
} from "@/lib/db";
import {
  computeLapDurationMs,
  loadCollectorConfig,
  WORKER_KINDS,
  type WorkerKind,
  type WorkerRun,
} from "@/lib/domain";

import { formatDateTime } from "../_lib/format";
import {
  WORKER_LABELS,
  describeOutcome,
  describeRotationPosition,
  describeRunDetail,
  describeWorkerState,
  formatMs,
  formatRunDuration,
  formatSuccessRate,
} from "../_lib/status-display";

export const dynamic = "force-dynamic";

/** 카드에 보여줄 최근 회차 개수. 전체 기록은 `GET /api/worker-runs`(페이지네이션)로 본다 —
 * 이 화면은 "지금 살아있는지"를 한눈에 보는 용도라 전체 목록을 그대로 옮기지 않는다. */
const RECENT_RUNS_LIMIT = 20;

/**
 * "최근 기간 집계"의 창(design.md Open Questions는 이 창을 고정할지 파라미터로 열지
 * "화면을 써보고 정해도 스펙·구조에 영향 없다"고 명시했다 — 우선 24시간으로 고정한다).
 * 보관 상한(기본 1000건, 10분 주기 기준 약 7일)보다 훨씬 짧게 잡아 "지금 상태"에 가까운
 * 창을 보여준다. 필요해지면 쿼리 파라미터로 열 수 있다(구조 변경 없음).
 */
const SUMMARY_WINDOW_MS = 24 * 60 * 60 * 1000;

function RunRow({ run, now }: { run: WorkerRun; now: Date }) {
  const outcome = describeOutcome(run.outcome);
  return (
    <li className="run-row">
      <span className="run-time">{formatDateTime(run.startedAt)}</span>
      <span className={`outcome-badge outcome-${outcome.severity}`}>{outcome.label}</span>
      <span className="run-duration">{formatRunDuration(run.startedAt, run.finishedAt, now)}</span>
      <span className="run-detail">{describeRunDetail(run)}</span>
    </li>
  );
}

/**
 * 로테이션 정보(한 바퀴 소요 시간·다음 위치, task 4.2/design.md D3) — collector 워커
 * 카드에만 붙는다. 법원을 추가할 때 신선도가 나빠지는 대가를 화면에서 바로 보이게
 * 하는 것이 목적이다(design.md D3/Risks) — 숨기지 않는 것이 최선의 대응이라는 판단.
 *
 * `loadCollectorConfig()`는 설정이 잘못되면 던진다(design.md D5, 의도된 fail-fast).
 * 워커 프로세스라면 그대로 죽는 게 맞지만, 이 화면은 그 워커가 죽었는지 아닌지를
 * 보러 오는 화면이다 — 설정 오류 때문에 상태 화면 전체가 깨지면 정작 봐야 할 다른
 * 정보(성공률·차단 여부 등)까지 가려진다. 그래서 여기서만 잡아 표시로 대체한다.
 */
function RotationInfo() {
  let config;
  try {
    config = loadCollectorConfig();
  } catch (error) {
    return (
      <p className="muted status-rotation-error">
        수집 설정을 불러올 수 없어 로테이션 정보를 표시할 수 없습니다: {String(error)}
      </p>
    );
  }

  const lapMs = computeLapDurationMs(
    config.scope.courts.length,
    config.scope.maxCourtsPerRun,
    config.intervalMs,
  );
  const nextCourtCode = getCollectorState(COLLECTOR_STATE_KEYS.ROTATION_NEXT_COURT_CODE);
  const rotation = describeRotationPosition(config.scope.courts, nextCourtCode);

  return (
    <dl className="status-summary status-rotation">
      <div className="status-summary-item">
        <dt>한 바퀴 소요 시간</dt>
        <dd>{formatMs(lapMs)}</dd>
      </div>
      <div className="status-summary-item">
        <dt>대상 법원 수</dt>
        <dd>
          {config.scope.courts.length}곳 (회차당 {config.scope.maxCourtsPerRun}곳)
        </dd>
      </div>
      <div className="status-summary-item">
        <dt>다음 로테이션 위치</dt>
        <dd>
          {rotation.nextCourtName} ({rotation.position}/{rotation.total})
        </dd>
      </div>
    </dl>
  );
}

function WorkerStatusCard({ worker, now }: { worker: WorkerKind; now: Date }) {
  const nowIso = now.toISOString();
  const status = getWorkerStatus(worker, { now: nowIso });
  const stateDisplay = describeWorkerState(status.state);
  const since = new Date(now.getTime() - SUMMARY_WINDOW_MS).toISOString();
  const summary = summarizeRuns({ worker, since });
  const { runs } = listWorkerRuns({ worker, pageSize: RECENT_RUNS_LIMIT });

  return (
    <section className={`card status-card status-${stateDisplay.severity}`}>
      <div className="status-card-head">
        <h2>{WORKER_LABELS[worker]} 워커</h2>
        <span className={`status-badge status-${stateDisplay.severity}`}>{stateDisplay.label}</span>
      </div>

      {/* 차단은 이 시스템의 가장 큰 운영 리스크라(design.md) 배지 색만이 아니라 별도
          배너로도 강조한다 — 다른 상태에는 이 배너가 없다. */}
      {stateDisplay.severity === "blocked" ? (
        <p className="status-alert">차단 상태입니다 — 지금 확인이 필요합니다.</p>
      ) : null}

      <p className="muted">{stateDisplay.description}</p>
      <p className="muted">마지막 성공 시각: {formatDateTime(status.lastSuccessAt)}</p>

      <dl className="status-summary">
        <div className="status-summary-item">
          <dt>최근 24시간 성공률</dt>
          <dd>{formatSuccessRate(summary.successRate)}</dd>
        </div>
        <div className="status-summary-item">
          <dt>차단 횟수</dt>
          <dd>{summary.blockedCount}</dd>
        </div>
        <div className="status-summary-item">
          <dt>누적 변경 건수</dt>
          <dd>{summary.itemsChanged}</dd>
        </div>
        <div className="status-summary-item">
          <dt>전체 회차</dt>
          <dd>{summary.totalRuns}</dd>
        </div>
      </dl>

      {/* 로테이션(법원 순환)은 collector 워커에만 있는 개념이다(design.md D1~D3) —
          analyzer 카드에는 붙이지 않는다. */}
      {worker === "collector" ? <RotationInfo /> : null}

      <h3>최근 회차</h3>
      {runs.length === 0 ? (
        <p className="empty">아직 실행 기록이 없습니다.</p>
      ) : (
        <ul className="run-list">
          {runs.map((run) => (
            <RunRow key={run.id} run={run} now={now} />
          ))}
        </ul>
      )}
    </section>
  );
}

export default function StatusPage() {
  // 렌더링 시작 시점 하나로 고정한다 — 표시 목적으로만 쓰이므로(목록 페이지와 같은 관례)
  // 카드마다 다시 계산하면 렌더 중 시각이 흔들려 "경과 시간" 표시가 이해하기 어려워진다.
  const now = new Date();

  // 관심 물건·변동 피드로 가는 경로에 미확인 개수를 보여준다(add-bookmarks-and-feed
  // task 4.5) — 목록/상세 페이지와 같은 이유.
  const unreadCount = getUnreadCount();

  return (
    <main className="page">
      <p className="breadcrumb">
        <Link href="/">← 물건 목록</Link>
        {" · "}
        <Link href="/bookmarks">관심 물건</Link>
        {" · "}
        <Link href="/feed">
          변동 피드{unreadCount > 0 ? ` (미확인 ${unreadCount.toLocaleString("ko-KR")}건)` : ""}
        </Link>
      </p>

      <header className="page-header">
        <h1>워커 상태</h1>
        <p className="muted">수집·분석 워커의 현재 상태와 최근 회차 기록입니다.</p>
      </header>

      <div className="status-grid">
        {WORKER_KINDS.map((worker) => (
          <WorkerStatusCard key={worker} worker={worker} now={now} />
        ))}
      </div>
    </main>
  );
}
