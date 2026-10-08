/**
 * `collector_state` 키-값 저장소 (scale-collection-scheduling design.md D2).
 *
 * `worker-runs.ts`와 같은 관례를 따른다: `createCollectorStateRepository(db)`로 연결을
 * 명시해 만들 수 있고, 모듈 최상단 export 함수들은 기본 싱글턴 연결(`getDb()`)을 쓴다.
 *
 * 이 저장소가 담는 것은 "관측 기록"이 아니라 "운영 상태"다 — `worker_runs`처럼 보관
 * 상한에 걸려 지워지면 안 된다(design.md D2 risk). 지금은 로테이션 다음 시작 법원 코드
 * 하나뿐이지만, 키를 상수로 관리해 두면 비슷한 상태가 늘어도 테이블을 새로 만들지 않고
 * 확장할 수 있다.
 */
import { getDb, type Db } from "./client";

/**
 * `collector_state.key`로 쓰는 값들. 키를 상수로 두는 이유: 문자열을 여기저기 흩어 쓰면
 * 오타로 조용히 새 키가 생겨도(=엉뚱한 값을 못 찾는 버그) 컴파일 시점에 잡을 수 없다.
 */
export const COLLECTOR_STATE_KEYS = {
  /**
   * 로테이션(design.md D2/D3)이 다음 회차에 시작할 법원의 **코드**(courtCode). 인덱스가
   * 아니라 코드를 저장한다 — 설정에서 법원이 추가·삭제·재정렬돼도 이 값으로 목록에서
   * 위치를 다시 찾을 수 있고, 못 찾으면(법원이 삭제됨) 처음부터 다시 시작한다
   * (`selectRotationCourts`, `src/lib/domain/rotation.ts`).
   */
  ROTATION_NEXT_COURT_CODE: "collector.rotation.nextCourtCode",
  /**
   * 차단 백오프 종료 시각(UTC ISO 문자열). 외부 소스에 요청하는 모든 워커(수집·사진)가
   * 이 키 하나를 함께 읽고 쓴다(fix-photo-worker-and-deploy-config design.md D2). 다른
   * 키와 이름 규칙이 다른 이유: 옛 사진 워커가 이미 이 이름으로 쓴 행이 운영 DB에 있을
   * 수 있어 그대로 읽히도록 맞췄다.
   */
  BACKOFF_UNTIL: "backoff_until",
} as const;

export type CollectorStateKey =
  (typeof COLLECTOR_STATE_KEYS)[keyof typeof COLLECTOR_STATE_KEYS];

export interface CollectorStateRepository {
  /** 저장된 값을 돌려준다. 키가 없으면(처음 실행 등) null — 호출자가 기본 동작으로 처리한다. */
  getCollectorState(key: string): string | null;
  /** 값을 저장한다(있으면 덮어쓴다, 없으면 새로 만든다). */
  setCollectorState(key: string, value: string, options?: { now?: string }): void;
  /** 백오프 종료 시각. 값이 없거나 파싱할 수 없으면 null. */
  getBackoffUntil(): Date | null;
  /**
   * 백오프 종료 시각을 늘린다. 저장된 값보다 **늦을 때만** 쓴다(짧아지지 않음). 읽기·비교·
   * 쓰기는 한 트랜잭션이다 — 두 워커가 같은 DB 파일을 쓴다.
   */
  extendBackoffUntil(until: Date, options?: { now?: string }): void;
}

function parseBackoff(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function createCollectorStateRepository(db: Db): CollectorStateRepository {
  const selectByKey = db.prepare<{ key: string }, { value: string }>(
    `SELECT value FROM collector_state WHERE key = @key`,
  );

  const upsert = db.prepare(`
    INSERT INTO collector_state (key, value, updated_at) VALUES (@key, @value, @now)
    ON CONFLICT(key) DO UPDATE SET value = @value, updated_at = @now
  `);

  const extend = db.transaction((until: Date, now: string) => {
    const row = selectByKey.get({ key: COLLECTOR_STATE_KEYS.BACKOFF_UNTIL });
    const current = parseBackoff(row?.value);
    if (current && current.getTime() >= until.getTime()) return;
    upsert.run({ key: COLLECTOR_STATE_KEYS.BACKOFF_UNTIL, value: until.toISOString(), now });
  });

  return {
    getBackoffUntil() {
      return parseBackoff(selectByKey.get({ key: COLLECTOR_STATE_KEYS.BACKOFF_UNTIL })?.value);
    },

    extendBackoffUntil(until, options) {
      extend.immediate(until, options?.now ?? new Date().toISOString());
    },

    getCollectorState(key) {
      const row = selectByKey.get({ key });
      return row ? row.value : null;
    },

    setCollectorState(key, value, options) {
      const now = options?.now ?? new Date().toISOString();
      upsert.run({ key, value, now });
    },
  };
}

let defaultCollectorStateRepository: CollectorStateRepository | undefined;
let defaultCollectorStateRepositoryDb: Db | undefined;

/** 기본 싱글턴 연결에 붙은 저장소. */
export function getCollectorStateRepository(): CollectorStateRepository {
  const db = getDb();
  if (!defaultCollectorStateRepository || defaultCollectorStateRepositoryDb !== db) {
    defaultCollectorStateRepository = createCollectorStateRepository(db);
    defaultCollectorStateRepositoryDb = db;
  }
  return defaultCollectorStateRepository;
}

export function getCollectorState(key: string): string | null {
  return getCollectorStateRepository().getCollectorState(key);
}

export function setCollectorState(
  key: string,
  value: string,
  options?: { now?: string },
): void {
  getCollectorStateRepository().setCollectorState(key, value, options);
}

export function getBackoffUntil(): Date | null {
  return getCollectorStateRepository().getBackoffUntil();
}

export function extendBackoffUntil(until: Date, options?: { now?: string }): void {
  getCollectorStateRepository().extendBackoffUntil(until, options);
}
