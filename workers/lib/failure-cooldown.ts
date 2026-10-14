/**
 * 물건별 분석 실패 쿨다운.
 *
 * 백엔드는 미분석/재분석 대상을 항상 같은 순서(경매기일 오름차순)로 돌려준다. 앞쪽 N건이
 * 계속 실패(거절, max_tokens, 타임아웃, 저장 500 등)하면 매 회차 같은 N건만 유료 호출로
 * 재시도하고 뒤의 물건은 영원히 분석되지 못한다(스펙 "신규 물건을 굶기지 않는다").
 * 실패한 물건을 지수 백오프 동안 대상에서 빼서 이를 막는다.
 *
 * 상태는 프로세스 메모리에만 둔다. 워커를 재시작하면 쿨다운이 사라져 실패 물건을 한 번씩
 * 다시 시도한다 — 허용된 한계다(재시작 빈도가 낮고, 백엔드 계약을 바꾸지 않기 위함).
 */

/** 첫 실패 후 대기 시간. 이후 연속 실패마다 2배. */
export const COOLDOWN_BASE_MS = 60 * 60 * 1000; // 1시간
/** 대기 시간 상한. */
export const COOLDOWN_MAX_MS = 24 * 60 * 60 * 1000; // 24시간

/** 같은 물건이 이 횟수만큼 연속으로 회차를 시스템 오류로 중단시키면 물건 탓으로 본다. */
export const SYSTEMIC_ABORT_LIMIT = 3;

export interface CooldownEntry {
  consecutiveFailures: number;
  nextRetryAt: number;
}

export class FailureCooldown {
  private readonly entries = new Map<number, CooldownEntry>();

  private abortStreak: { itemId: number; count: number } | null = null;

  constructor(private readonly now: () => number = Date.now) {}

  /** n번째 연속 실패 뒤의 대기 시간(ms). 상한 적용. */
  static backoffMs(consecutiveFailures: number): number {
    const exponent = Math.max(0, consecutiveFailures - 1);
    // 2**exponent가 과도하게 커지지 않도록 지수도 막는다.
    return Math.min(COOLDOWN_BASE_MS * 2 ** Math.min(exponent, 30), COOLDOWN_MAX_MS);
  }

  recordFailure(itemId: number): CooldownEntry {
    const failures = (this.entries.get(itemId)?.consecutiveFailures ?? 0) + 1;
    if (this.abortStreak?.itemId === itemId) this.abortStreak = null;
    const entry = { consecutiveFailures: failures, nextRetryAt: this.now() + FailureCooldown.backoffMs(failures) };
    this.entries.set(itemId, entry);
    return entry;
  }

  recordSuccess(itemId: number): void {
    this.entries.delete(itemId);
    if (this.abortStreak?.itemId === itemId) this.abortStreak = null;
  }

  /**
   * 시스템 오류로 회차가 중단된 물건을 기록한다. 오분류로 같은 물건이 매 회차 중단을 일으켜
   * 뒤 물건이 굶는 것을 막는 안전망: 같은 물건이 연속 SYSTEMIC_ABORT_LIMIT번 중단시키면
   * 쿨다운에 넣고 true를 돌려준다(호출자가 경고를 남긴다).
   */
  recordSystemicAbort(itemId: number): boolean {
    const count = this.abortStreak?.itemId === itemId ? this.abortStreak.count + 1 : 1;
    if (count >= SYSTEMIC_ABORT_LIMIT) {
      this.abortStreak = null;
      this.recordFailure(itemId);
      return true;
    }
    this.abortStreak = { itemId, count };
    return false;
  }

  /** 시스템 오류 중단 없이 회차가 끝났을 때 연속 중단 기록을 지운다. */
  clearAbortStreak(): void {
    this.abortStreak = null;
  }

  /** 지금 쿨다운 중인가. 만료된 항목은 실패 횟수를 유지한 채(다음 실패의 백오프 계산용) 통과시킨다. */
  isCoolingDown(itemId: number): boolean {
    const entry = this.entries.get(itemId);
    return entry !== undefined && entry.nextRetryAt > this.now();
  }

  /** 현재 쿨다운 중인 물건 수. 후보 조회 크기를 늘리는 상한값으로 쓴다. */
  coolingCount(): number {
    const now = this.now();
    let count = 0;
    for (const entry of this.entries.values()) if (entry.nextRetryAt > now) count += 1;
    return count;
  }

  get(itemId: number): CooldownEntry | undefined {
    return this.entries.get(itemId);
  }
}
