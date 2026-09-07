/**
 * 서비스 전체가 공유하는 정규화 도메인 모델.
 *
 * 규칙:
 * - 소스(법원경매정보 등) 고유 형식은 이 파일에 들어오지 않는다. 어댑터가 여기 정의된
 *   타입으로 변환해서 내보낸다 (design.md D3).
 * - 코드에서는 영문 필드명을 쓰고, 뜻이 분명하지 않은 필드에만 한글 주석을 붙인다.
 * - DB의 snake_case 컬럼명은 `src/lib/db` 밖으로 새어 나가지 않는다.
 */

/** 금액(원). 정수로만 다룬다 — 소수점 이하 단위가 없고 부동소수 오차를 피하기 위함. */
export type Won = number;

/** ISO 8601 날짜 문자열. 매각기일처럼 날짜만 있는 값은 `YYYY-MM-DD`. */
export type IsoDate = string;

/** ISO 8601 날짜·시각 문자열(UTC). 예: `2026-09-06T04:12:33.000Z`. */
export type IsoDateTime = string;

/**
 * 어댑터가 반환하는 물건 한 건. DB에 저장되기 전 형태라 `id`와 수집 시각이 없다.
 *
 * nullable 필드는 "소스가 값을 주지 않을 수 있다"는 뜻으로 optional(`?`)이 아니라
 * `| null`로 둔다 — 어댑터가 필드 자체를 빠뜨리는 실수를 타입 검사에서 잡기 위함.
 * 자연 키인 court/caseNo/itemNo는 spec상 누락 시 결과에서 제외되므로 non-null이다.
 */
export interface AuctionItemInput {
  /** 법원 (담당 법원 이름). 자연 키의 일부. */
  court: string;
  /** 사건번호. 예: `2025타경12345`. 자연 키의 일부. */
  caseNo: string;
  /** 물건번호. 한 사건에 여러 물건이 붙는다. 예: `1`. 자연 키의 일부. */
  itemNo: string;
  /** 소재지 */
  address: string | null;
  /** 용도. 예: `아파트`, `다세대주택`, `토지` */
  usageType: string | null;
  /** 감정가(원) */
  appraisalPrice: Won | null;
  /** 최저매각가격(원) */
  minBidPrice: Won | null;
  /** 매각기일 */
  auctionDate: IsoDate | null;
  /** 유찰횟수 */
  failedBidCount: number | null;
  /** 진행상태. 소스가 주는 문자열을 그대로 보존한다. 예: `진행`, `변경`, `취하` */
  status: string | null;
}

/** DB에 저장된 물건 한 건. */
export interface AuctionItem extends AuctionItemInput {
  id: number;
  /** 최초 수집 시각. 한번 기록되면 갱신되지 않는다. */
  firstSeenAt: IsoDateTime;
  /** 최종 수집 시각. 같은 물건을 다시 수집할 때마다 갱신된다. */
  lastSeenAt: IsoDateTime;
  /**
   * 감시 대상 필드의 가장 최근 **실제** 변경 시각(기준점 제외). null이면 변경 이력이 없다는
   * 뜻이다(기존 DB의 물건일 수도, 아직 한 번도 안 바뀐 물건일 수도 있다 — design.md D6은
   * 이 둘을 같게 다루라고 한다).
   *
   * `listItems`가 스칼라 서브쿼리로 채우는 값이다(design.md D6) — 목록 쿼리의
   * 필터·정렬·total에는 관여하지 않는다. optional인 이유: 이 값을 계산하지 않는 다른
   * 생성 경로(`getItemById`, 이 필드를 모르는 기존 워커·테스트 코드의 객체 리터럴)가
   * 매번 명시적으로 null을 채워 넣게 강제하지 않기 위함이다 — `getItemById`는 그래도
   * 항상 null을 채운다.
   */
  lastChangedAt?: IsoDateTime | null;
}

/**
 * 값이 바뀌면 변경 이력을 남기는 감시 대상 필드 (design.md D1).
 * `field`에는 이 이름을 그대로 쓴다 — DB 컬럼명(snake_case)이 아니다.
 */
export const WATCHED_FIELDS = ["minBidPrice", "failedBidCount", "auctionDate", "status"] as const;
export type WatchedField = (typeof WATCHED_FIELDS)[number];

/**
 * 이력 행의 종류: 최초 저장 시의 기준점인지, 실제 값 변경인지 (코드 리뷰 finding 1).
 *
 * 이전에는 `oldValue === null`을 이 구별의 유일한 마커로 썼다. 하지만 "값이 없던 필드에
 * 값이 생기는" 실제 변경(예: 비어 있던 매각기일이 잡히는 경우)도 `oldValue === null`이라
 * 기준점과 구별할 수 없었다 — 그 변경이 상세 화면·재분석 대상 선정·목록의 "최근 변동"
 * 표시에서 통째로 사라지는 버그였다. `kind`가 이제 유일한 마커다.
 */
export type ItemChangeKind = "baseline" | "change";

/**
 * 물건의 감시 대상 필드 변경 이력 한 건 (design.md D1).
 *
 * `oldValue`/`newValue`는 항상 문자열이다 — 가격(숫자)·매각기일·상태(문자열)가 섞여 있어
 * DB에도 TEXT로 저장되고(D1), 표시 계층이 `field`를 보고 해석한다.
 *
 * `kind === "baseline"`이면 최초 저장 시의 기준점 행이지 실제 변경이 아니다(design.md D2,
 * finding 1로 마커가 `oldValue === null`에서 `kind`로 바뀌었다) — 표시 계층은 이 값으로
 * 기준점과 실제 변경을 구별해야 한다.
 */
export interface ItemChange {
  id: number;
  itemId: number;
  field: WatchedField;
  oldValue: string | null;
  newValue: string | null;
  changedAt: IsoDateTime;
  kind: ItemChangeKind;
}

/** 분석 결과 저장 요청. */
export interface AnalysisInput {
  itemId: number;
  /** 분석 본문(markdown) */
  body: string;
  /** 분석에 쓴 모델 식별자. CLI 출력에 없을 수 있어 nullable. */
  model: string | null;
  /** 프롬프트 템플릿 버전. 예: `v1` (design.md D5) */
  promptVersion: string;
}

/** DB에 저장된 분석 결과. 물건당 여러 건이 쌓일 수 있고 최신 것을 표시한다. */
export interface Analysis extends AnalysisInput {
  id: number;
  analyzedAt: IsoDateTime;
}

/** 수집 대상 법원 한 곳. */
export interface CourtRef {
  /** 법원 이름. 예: `서울중앙지방법원` */
  name: string;
  /** 소스가 쓰는 법원 코드. 어댑터 구현 전에는 빈 문자열일 수 있다. */
  courtCode: string;
}

/** 수집 범위. `AuctionSource.fetchActiveItems(scope)`의 인자 타입. */
export interface CollectScope {
  courts: CourtRef[];
}

/** `config/collector.json`의 analysis 절. */
export interface AnalysisConfig {
  /**
   * 분석 회차당 최대 **신규** 분석 건수 — Claude 호출 비용 통제용 (design.md D5).
   * 재분석은 이 한도와 무관하다 — `maxReanalysisPerRun`이 따로 있다.
   */
  maxItemsPerRun: number;
  /**
   * 분석 회차당 최대 **재분석** 건수(design.md D5). 신규 분석과 별개의 독립된 한도다 —
   * 총 호출 수 상한은 `maxItemsPerRun + maxReanalysisPerRun`이다. 기본값은 2 — 재분석은
   * 유찰이 발생할 때마다 생기고 상한이 없으면 유찰이 몰린 날 호출이 폭증한다.
   */
  maxReanalysisPerRun: number;
  /**
   * 재분석 쿨다운(시간 단위, 코드 리뷰 finding 3). 물건의 최신 분석이 이 시간 이내면
   * 감시 필드가 다시 바뀌어도 재분석 대상에서 제외한다. 소스가 감시 필드를 회차마다
   * 뒤집어 보고하면(예: `failedBidCount`가 일시적으로 유실됐다 복구되는 패턴) 매 회차가
   * 유효한 변경으로 기록돼 재분석이 하루 수백 번 유발될 수 있다 — 회차당 건수 제한
   * (`maxReanalysisPerRun`)만으로는 그 물건이 매 회차 한도를 계속 차지하는 것을 막지
   * 못한다. 기본값 24 — 실제 유찰은 월 단위로 일어나므로 24시간 안에서는 정상적인
   * 재분석 요구가 없다는 전제다. 0을 허용한다(쿨다운 없음 = 이전 동작).
   */
  reanalysisCooldownHours: number;
  /** 분석 워커 주기(ms) */
  intervalMs: number;
}

/** `config/collector.json`의 observability 절 (add-collection-observability design.md D6). */
export interface ObservabilityConfig {
  /**
   * 워커별 최대 회차 기록 보존 건수. 이 건수를 넘으면 오래된 기록부터 정리된다
   * (design.md D6). 기간이 아니라 건수로 두는 이유: 주기를 바꿔도 상한이 곧 최대 행
   * 수라는 의미가 흔들리지 않는다.
   */
  maxRunsPerWorker: number;
  /**
   * 상태 판정(design.md D5)에서 "오래 방치됨"으로 볼 배수. 마지막 성공(또는 마지막
   * 기록)이 워커의 기대 주기(`intervalMs`) × 이 값보다 오래되면 `stale`로 판정한다.
   */
  staleAfterIntervals: number;
}

/** `config/collector.json` 전체. */
export interface CollectorConfig {
  scope: CollectScope;
  /** 수집 주기(ms) */
  intervalMs: number;
  analysis: AnalysisConfig;
  observability: ObservabilityConfig;
}

// ---------------------------------------------------------------------------
// 실행 회차 관측 (add-collection-observability, design.md D1/D5)
// ---------------------------------------------------------------------------

/** 회차를 기록하는 워커 종류. */
export const WORKER_KINDS = ["collector", "analyzer"] as const;
export type WorkerKind = (typeof WORKER_KINDS)[number];

/**
 * 회차 결과 구분(design.md D1). `blocked`를 `failed`의 하위가 아니라 별도 값으로 둔다 —
 * 스펙이 구별을 MUST로 요구하고, 화면·집계에서 따로 취급해야 한다.
 */
export const RUN_OUTCOMES = ["running", "success", "failed", "blocked", "skipped"] as const;
export type RunOutcome = (typeof RUN_OUTCOMES)[number];

/**
 * `skipped` 회차의 사유. `error_kind` 컬럼에 그대로 들어간다(design.md D1) — 별 컬럼을
 * 만들 만한 정보량이 아니라는 판단.
 */
export const SKIP_REASONS = ["overlap", "backoff"] as const;
export type SkipReason = (typeof SKIP_REASONS)[number];

/** collector 회차의 표시용 수치(design.md D1) — `detail` JSON에 그대로 저장된다. */
export interface CollectorRunDetail {
  /** 이번 회차가 대상으로 삼은 법원 이름들. */
  targetCourts: string[];
  /** 요청한 페이지 수. */
  pagesRequested: number;
  /** 소스에서 가져온 물건 수. */
  itemsFetched: number;
  inserted: number;
  updated: number;
  /**
   * 감시 대상 필드가 실제로 바뀐 물건 수. `worker_runs.items_changed` 컬럼(집계용)과
   * 항상 같은 값이어야 한다 — 두 값의 동기화는 `finishRun` 한 곳에서만 이뤄진다
   * (design.md D1 risk, 코드 리뷰 대상).
   */
  changed: number;
}

/** analyzer 회차의 표시용 수치(design.md D1) — `detail` JSON에 그대로 저장된다. */
export interface AnalyzerRunDetail {
  /** 신규 분석 건수. */
  newCount: number;
  /** 재분석 건수. */
  reanalysisCount: number;
  succeeded: number;
  failed: number;
}

/** 워커별로 다른 `detail` JSON의 형태. `worker` 컬럼 값으로 어느 쪽인지 구별한다. */
export type WorkerRunDetail = CollectorRunDetail | AnalyzerRunDetail;

/** `worker_runs` 테이블의 회차 한 건(design.md D1). */
export interface WorkerRun {
  id: number;
  worker: WorkerKind;
  startedAt: IsoDateTime;
  /** 아직 끝나지 않은(`outcome: "running"`) 회차는 null이다. */
  finishedAt: IsoDateTime | null;
  outcome: RunOutcome;
  /** 오류 클래스 이름(예: `RobotDetectedError`) 또는 `skipped`의 사유(`overlap`/`backoff`). */
  errorKind: string | null;
  errorMessage: string | null;
  detail: WorkerRunDetail | null;
  /**
   * 집계용 컬럼(design.md D1). `detail`이 collector 형태면 `detail.changed`와 항상 같은
   * 값이고, analyzer 회차나 detail이 없는 회차는 null이다.
   */
  itemsChanged: number | null;
}

/** `getWorkerStatus`가 판정하는 상태(design.md D5). */
export const WORKER_STATUS_STATES = ["ok", "blocked", "failed", "stale"] as const;
export type WorkerStatusState = (typeof WORKER_STATUS_STATES)[number];

/** 워커의 현재 상태 판정 결과(design.md D5). 기록에서 매번 도출되고 저장되지 않는다. */
export interface WorkerStatus {
  state: WorkerStatusState;
  /** 가장 최근 성공 회차의 종료 시각. 성공 회차가 없으면 null. */
  lastSuccessAt: IsoDateTime | null;
  /** 가장 최근 회차(결과와 무관, `running`/`skipped` 포함). 기록이 전혀 없으면 null. */
  lastRun: WorkerRun | null;
}
