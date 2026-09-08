/**
 * 매각기일까지 남은 일수(D-day)를 계산하는 순수 헬퍼 (ux-overhaul-phase1 design.md D5,
 * tasks.md 5.1).
 *
 * 실데이터 389건 중 121건(31%)이 오늘이 매각기일이고, 기본 정렬이 매각기일 오름차순이라
 * 매일 첫 페이지가 "오늘 입찰이 끝나는 물건"으로 채워진다. 이 change는 **표시만** 추가한다
 * — 기본 정렬·필터는 건드리지 않는다(design.md D5, 6회차에서 법원 로테이션을 중간에
 * 끊지 않기로 한 것과 같은 원칙: 조용히 물건이 사라지면 안 된다).
 *
 * `format.ts`의 관례를 그대로 따른다: `auctionDate`는 `YYYY-MM-DD`(시각·시간대 정보
 * 없음)이므로 `new Date("YYYY-MM-DD")`로 파싱하지 않는다 — 그건 UTC 자정으로 해석되어
 * 한국 시간대(UTC+9)에서는 그날 오전 9시 이전 내내 하루 전날로 보인다. "오늘"도 항상
 * 서울 시간대의 달력 날짜로 구한다(`now`가 어떤 시각이든 무관하게).
 */
import { EMPTY } from "./format";

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

const seoulDateOnly = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Seoul",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export type DDayStatus = "today" | "upcoming" | "past" | "unknown";

export interface DDayResult {
  status: DDayStatus;
  /** `status`가 "unknown"이면 null. 그 외에는 (매각기일 - 오늘)일수 — 음수면 지난 것. */
  days: number | null;
}

/**
 * `auctionDate`(`YYYY-MM-DD` 또는 null)와 기준 시각(`now`, 기본값 현재)으로 D-day를
 * 계산한다. 값이 없거나 형식이 예상과 다르면(`YYYY-MM-DD`가 아니면) "unknown" — 짐작해
 * 날짜를 지어내지 않는다.
 *
 * 두 날짜 모두 "그 날짜의 UTC 자정"으로 바꿔 일수 차이만 뺀다 — 실제 시각대·DST 보정
 * 없이 순수하게 달력 날짜 간의 일수 차만 필요하기 때문에, 두 쪽 다 같은 방식(UTC 자정)을
 * 쓰면 시간대 오차 없이 정확한 일수가 나온다.
 */
export function computeDDay(
  auctionDate: string | null | undefined,
  now: Date = new Date(),
): DDayResult {
  if (typeof auctionDate !== "string") return { status: "unknown", days: null };
  const match = DATE_ONLY.exec(auctionDate);
  if (!match) return { status: "unknown", days: null };

  const [, y, m, d] = match;
  const targetUtcMs = Date.UTC(Number(y), Number(m) - 1, Number(d));

  const todayStr = seoulDateOnly.format(now); // "YYYY-MM-DD" (en-CA 로케일)
  const todayMatch = DATE_ONLY.exec(todayStr);
  if (!todayMatch) return { status: "unknown", days: null };
  const [, ty, tm, td] = todayMatch;
  const todayUtcMs = Date.UTC(Number(ty), Number(tm) - 1, Number(td));

  const days = Math.round((targetUtcMs - todayUtcMs) / (24 * 60 * 60 * 1000));
  const status: DDayStatus = days === 0 ? "today" : days > 0 ? "upcoming" : "past";
  return { status, days };
}

/** D-day를 화면 문자열로 만든다: "오늘"/"D-3"/"지남". 계산 불가면 EMPTY("-"). */
export function formatDDay(result: DDayResult): string {
  switch (result.status) {
    case "unknown":
      return EMPTY;
    case "today":
      return "오늘";
    case "past":
      return "지남";
    case "upcoming":
      return `D-${result.days}`;
  }
}
