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
} as const;

export type CollectorStateKey =
  (typeof COLLECTOR_STATE_KEYS)[keyof typeof COLLECTOR_STATE_KEYS];

export interface CollectorStateRepository {
  /** 저장된 값을 돌려준다. 키가 없으면(처음 실행 등) null — 호출자가 기본 동작으로 처리한다. */
  getCollectorState(key: string): string | null;
  /** 값을 저장한다(있으면 덮어쓴다, 없으면 새로 만든다). */
  setCollectorState(key: string, value: string, options?: { now?: string }): void;
}

export function createCollectorStateRepository(db: Db): CollectorStateRepository {
  const selectByKey = db.prepare<{ key: string }, { value: string }>(
    `SELECT value FROM collector_state WHERE key = @key`,
  );

  const upsert = db.prepare(`
    INSERT INTO collector_state (key, value, updated_at) VALUES (@key, @value, @now)
    ON CONFLICT(key) DO UPDATE SET value = @value, updated_at = @now
  `);

  return {
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
