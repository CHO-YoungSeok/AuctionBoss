/**
 * 전역 `Date` 고정 (add-spring-write-api D10 시각 규칙).
 *
 * 원본 핸들러·저장소는 `new Date().toISOString()`과 `Date.now()`로 "지금"을 정한다. 시나리오 골든은
 * 단계마다 서버 시각을 못박아야 하므로, 함수를 도는 동안만 전역 `Date`를 대체한다.
 *  - 인자 없는 `new Date()`와 `Date.now()`만 고정한다. `new Date(x)`, `Date.parse`, `Date.UTC`는 원래대로다.
 *  - 타이머(setTimeout 등)는 건드리지 않는다.
 *
 * vi.useFakeTimers를 쓰지 않은 이유: 생성기는 vitest 밖(tsx)에서 돌고, fake timers는 타이머까지 가짜로
 * 바꿔 비동기 핸들러를 멈출 수 있다. 필요한 것은 "지금" 하나뿐이라 Date 서브클래스로 충분하다.
 */
export async function withFixedNow<T>(nowIso: string, fn: () => T | Promise<T>): Promise<T> {
  const RealDate = Date;
  const fixedMs = RealDate.parse(nowIso);
  if (Number.isNaN(fixedMs)) throw new Error(`고정할 시각이 올바르지 않습니다: ${nowIso}`);

  class FixedDate extends RealDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) super(fixedMs);
      else super(...(args as [number]));
    }
    static override now(): number {
      return fixedMs;
    }
  }

  const g = globalThis as { Date: DateConstructor };
  g.Date = FixedDate as unknown as DateConstructor;
  try {
    return await fn();
  } finally {
    g.Date = RealDate;
  }
}
