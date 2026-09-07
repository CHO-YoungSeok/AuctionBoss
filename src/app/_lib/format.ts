/**
 * 화면 표시용 포맷 헬퍼.
 *
 * `src/app` 안에서만 쓰는 표현 계층 유틸이다. 도메인 값(원 단위 정수, ISO 문자열)을
 * 사람이 읽는 문자열로 바꾸는 책임만 지고, 값이 없으면 항상 `EMPTY`("-")를 돌려준다.
 * `_lib`처럼 밑줄로 시작하는 디렉터리는 App Router가 라우트로 취급하지 않는다.
 */
import type { IsoDate, IsoDateTime, SortDirection, SortKey, Won } from "@/lib/domain";

/**
 * 정렬 기준의 화면 표시 이름. `SortKey`를 키로 하는 `Record`라, 도메인에 정렬 기준이
 * 추가되면 여기가 컴파일 오류로 걸린다(라벨 없는 선택지가 조용히 빠지지 않는다).
 */
export const SORT_LABELS: Record<SortKey, string> = {
  auctionDate: "매각기일",
  minBidPrice: "최저매각가격",
  bidRatio: "감정가 대비 최저가",
  failedBidCount: "유찰횟수",
};

export const DIRECTION_LABELS: Record<SortDirection, string> = {
  asc: "오름차순",
  desc: "내림차순",
};

/** 값이 없는 필드의 표시 문자열. */
export const EMPTY = "-";

const wonFormatter = new Intl.NumberFormat("ko-KR");

/** 금액을 천 단위 구분 기호와 함께 표시한다. 예: `1250000000` → `1,250,000,000원` */
export function formatWon(value: Won | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return EMPTY;
  return `${wonFormatter.format(value)}원`;
}

/** 정수 카운트. 0은 그대로 `0`으로 표시한다(값 없음과 구분). */
export function formatCount(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return EMPTY;
  return `${wonFormatter.format(value)}회`;
}

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * 날짜만 있는 값(매각기일)을 표시한다.
 *
 * `YYYY-MM-DD`는 시각·시간대 정보가 없으므로 `Date`로 파싱하지 않는다 —
 * 파싱하면 UTC로 해석돼 한국 시간대에서 하루 밀려 보일 수 있다.
 */
export function formatDate(value: IsoDate | null | undefined): string {
  if (!value) return EMPTY;
  const match = DATE_ONLY.exec(value);
  if (!match) return value;
  return `${match[1]}-${match[2]}-${match[3]}`;
}

const seoulParts = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Seoul",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/** 수집·분석 시각(UTC ISO)을 한국 시간으로 표시한다. 예: `2026-09-06 13:12` */
export function formatDateTime(value: IsoDateTime | null | undefined): string {
  if (!value) return EMPTY;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const parts = new Map(seoulParts.formatToParts(date).map((p) => [p.type, p.value]));
  const y = parts.get("year");
  const m = parts.get("month");
  const d = parts.get("day");
  const hh = parts.get("hour");
  const mm = parts.get("minute");
  if (!y || !m || !d || !hh || !mm) return value;
  return `${y}-${m}-${d} ${hh}:${mm}`;
}

/** 문자열 필드. 빈 문자열도 값 없음으로 본다. */
export function formatText(value: string | null | undefined): string {
  if (value === null || value === undefined || value.trim() === "") return EMPTY;
  return value;
}
