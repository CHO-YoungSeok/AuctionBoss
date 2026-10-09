/**
 * 법원 로테이션 순수 함수 (scale-collection-scheduling design.md D1~D3).
 *
 * DB·워커 상태를 전혀 모른다 — "법원 목록 + 저장된 위치 + 회차당 상한"만 받아
 * "이번 회차 대상 법원들 + 다음 회차 시작 위치"를 계산한다. 저장/조회는
 * 백엔드(`RotationSelector`)가, 회차 실행은 백엔드 수집 스케줄러가 맡는다.
 */
import type { CourtRef } from "./types";

export interface RotationSelection {
  /** 이번 회차가 대상으로 삼을 법원들. 원형 순서, 목록 안에서 최대 `limit`개, 중복 없음. */
  selectedCourts: CourtRef[];
  /**
   * 이번 선택이 전부 성공적으로 끝났다고 가정했을 때 다음 회차가 시작할 법원 코드.
   * 실제로 다음 회차에 이 값을 그대로 쓸지는 호출자(workers/collector.ts)가
   * 이번 회차의 결과(성공/실패/차단)를 보고 정한다 — 이 함수는 그 판단에 관여하지 않는다.
   */
  nextStartCourtCode: string;
}

/**
 * 원형 로테이션 선택(design.md D2/D3).
 *
 * - `startCourtCode`가 목록에 없으면(법원이 삭제됐거나 처음 실행이라 null) 처음(인덱스 0)부터
 *   시작한다 — 인덱스가 아니라 코드를 저장하는 이유가 여기서 드러난다: 목록이 바뀌어도
 *   "못 찾으면 처음부터"로 항상 안전하게 복구된다.
 * - `limit`은 목록 길이를 넘지 않게 자른다 — 법원이 3곳인데 상한이 10이면 3곳을 한 번씩만
 *   고른다(같은 법원을 중복으로 고르지 않는다).
 * - 법원 목록이 비어 있으면 계산할 수 없다 — 설정 로더가 이미 "법원 최소 1곳"을 강제하므로
 *   (`collectScopeSchema`), 여기 도달했다면 그 자체가 호출자 버그다.
 */
export function selectRotationCourts(
  courts: readonly CourtRef[],
  startCourtCode: string | null,
  limit: number,
): RotationSelection {
  if (courts.length === 0) {
    throw new Error("법원 목록이 비어 있으면 로테이션을 계산할 수 없습니다");
  }

  const boundedLimit = Math.max(1, Math.min(Math.trunc(limit) || 1, courts.length));
  const startIndex =
    startCourtCode === null
      ? 0
      : (() => {
          const idx = courts.findIndex((c) => c.courtCode === startCourtCode);
          return idx === -1 ? 0 : idx;
        })();

  const selectedCourts: CourtRef[] = [];
  for (let i = 0; i < boundedLimit; i += 1) {
    selectedCourts.push(courts[(startIndex + i) % courts.length]!);
  }

  const nextIndex = (startIndex + boundedLimit) % courts.length;
  const nextStartCourtCode = courts[nextIndex]!.courtCode;

  return { selectedCourts, nextStartCourtCode };
}

/**
 * 전체 법원을 한 번씩 수집하는 데 걸리는 예상 시간(design.md D3) —
 * `ceil(법원 수 / maxCourtsPerRun) × intervalMs`.
 *
 * 법원을 추가하면 이 값이 즉시 나빠지는 것을 화면에 보여주는 것이 목적이다(신선도의
 * 대가를 눈에 보이게 함). 법원이 0곳이면(설정상 있을 수 없지만 방어적으로) 0을 돌려준다.
 */
export function computeLapDurationMs(
  courtCount: number,
  maxCourtsPerRun: number,
  intervalMs: number,
): number {
  if (courtCount <= 0) return 0;
  const perRun = Math.max(1, Math.trunc(maxCourtsPerRun) || 1);
  const laps = Math.ceil(courtCount / perRun);
  return laps * intervalMs;
}
