/**
 * 화면 표시용 포맷 헬퍼.
 *
 * `src/app` 안에서만 쓰는 표현 계층 유틸이다. 도메인 값(원 단위 정수, ISO 문자열)을
 * 사람이 읽는 문자열로 바꾸는 책임만 지고, 값이 없으면 항상 `EMPTY`("-")를 돌려준다.
 * `_lib`처럼 밑줄로 시작하는 디렉터리는 App Router가 라우트로 취급하지 않는다.
 */
import {
  WON_PER_EOK,
  WON_PER_MAN,
  type IsoDate,
  type IsoDateTime,
  type SortDirection,
  type SortKey,
  type Won,
} from "@/lib/domain";

/**
 * 정렬 기준의 화면 표시 이름. `SortKey`를 키로 하는 `Record`라, 도메인에 정렬 기준이
 * 추가되면 여기가 컴파일 오류로 걸린다(라벨 없는 선택지가 조용히 빠지지 않는다).
 */
export const SORT_LABELS: Record<SortKey, string> = {
  auctionDate: "매각기일",
  minBidPrice: "최저매각가격",
  bidRatio: "감정가 대비 최저가",
  failedBidCount: "유찰횟수",
  pricePerArea: "면적당 가격",
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

/**
 * 원 단위 정수를 "3억 5,000만원" 같은 사람이 읽는 억/만원 표기로 바꾼다(ux-overhaul-phase2
 * tasks.md 2.4). 실데이터가 76만원~261억까지 걸쳐 있어(proposal.md) 원 단위 11자리 숫자로는
 * "지금 얼마로 걸려 있는지"가 한눈에 안 들어온다 — 이 함수는 그 표시 전용이다.
 *
 * API 파라미터(`minPrice`/`maxPrice`)는 여전히 원 정수다(design.md D3) — 이 함수는 순수
 * 표시 변환이고 파싱의 역방향이 아니다. 만원 미만 잔액(억/만원으로 나눠떨어지지 않는
 * 부분)이 있으면 마지막에 원 단위로 그대로 덧붙인다 — 값을 조용히 반올림하거나 버리지
 * 않는다. `WON_PER_EOK`/`WON_PER_MAN`은 도메인(`item-query.ts`)의 억/만원 합산 로직과
 * 같은 상수를 가져다 쓴다 — 두 곳이 각자 100_000_000을 하드코딩하면 하나만 바뀌었을 때
 * 표시와 파싱이 어긋난다.
 */
export function formatWonAsEokMan(value: Won | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return EMPTY;
  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(value);
  const eok = Math.floor(abs / WON_PER_EOK);
  const afterEok = abs % WON_PER_EOK;
  const man = Math.floor(afterEok / WON_PER_MAN);
  const won = afterEok % WON_PER_MAN;

  const parts: string[] = [];
  if (eok > 0) parts.push(`${wonFormatter.format(eok)}억`);
  if (man > 0) parts.push(`${wonFormatter.format(man)}만원`);
  if (won > 0 || parts.length === 0) parts.push(`${wonFormatter.format(won)}원`);

  return `${sign}${parts.join(" ")}`;
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

const AUCTION_TIME_HHMM = /^(\d{2})(\d{2})$/;

/**
 * 매각기일 시각(`auctionTime`, 예: `"1000"`)을 사람이 읽는 `"10:00"`으로 바꾼다
 * (ux-overhaul-phase1 spec: "매각기일 시각 표시", tasks.md 5.3).
 *
 * 도메인 필드(`AuctionItem.auctionTime`) 주석은 "원문 형식을 그대로 보존한다, 콜론으로
 * 재포맷하지 않는다"고 적었는데 — 그건 **저장 계층**의 규칙이다(원문 손실 없이 보관해야
 * 나중에 언제든 재해석할 수 있다는 원칙). 표시 계층은 다르다: 소스가 준 원문이 사람이
 * 읽기 어려운 형식이면 화면에서는 읽을 수 있게 바꿔야 한다(spec 요구사항, MUST). 실데이터
 * 389건 전부가 `"1000"`이라 지금까지는 화면에 그대로 노출되고 있었다.
 *
 * 네 자리 숫자(`HHMM`)가 아니면(형식이 예상과 다르면) 원문을 그대로 보여준다 — 짐작해서
 * 바꾸지 않는다.
 */
export function formatAuctionTime(value: string | null | undefined): string {
  if (value === null || value === undefined || value.trim() === "") return EMPTY;
  const trimmed = value.trim();
  const match = AUCTION_TIME_HHMM.exec(trimmed);
  if (!match) return trimmed;
  const [, hh, mm] = match;
  return `${hh}:${mm}`;
}
