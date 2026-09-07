/**
 * 물건 상세/목록 화면이 변경 이력(`ItemChange[]`)을 표시하기 위해 쓰는 순수 헬퍼.
 *
 * 판단 로직(기준점/실제 변경 구별, 최근 변동 여부, 가격 변화폭 계산)을 JSX 밖으로 뽑아
 * 테스트로 고정한다 — 이전 주기에는 이런 표시 판단이 JSX 조건문에 인라인돼 있다가
 * 버그가 나서야 발견된 적이 있다.
 */
import type { IsoDateTime, ItemChange, WatchedField } from "@/lib/domain";

import { EMPTY, formatCount, formatDate, formatText, formatWon } from "./format";

/** 감시 대상 필드의 화면 표시 이름. `WatchedField`를 키로 하는 `Record`라, 도메인에
 * 필드가 추가되면 여기가 컴파일 오류로 걸린다(라벨 없는 필드가 조용히 raw key로 새지 않는다). */
export const WATCHED_FIELD_LABELS: Record<WatchedField, string> = {
  minBidPrice: "최저매각가격",
  failedBidCount: "유찰횟수",
  auctionDate: "매각기일",
  status: "진행상태",
};

/** 목록에서 "최근 변동"으로 표시할 기준 일수 (design.md D6). 상수라 바꾸기 쉽다. */
export const RECENT_CHANGE_DAYS = 7;
const RECENT_CHANGE_MS = RECENT_CHANGE_DAYS * 24 * 60 * 60 * 1000;

/**
 * 이 변경 행이 기준점(최초 저장 시 기록, `oldValue === null`)이 아니라 실제 변경인지
 * 판정한다 (design.md D2). 기준점은 이력 목록에 표시하지 않는다.
 */
export function isRealChange(change: Pick<ItemChange, "oldValue">): boolean {
  return change.oldValue !== null;
}

/**
 * 이력 전체에 실제 변경이 하나라도 있는지 판정한다.
 *
 * 빈 배열(레거시 물건 — 기준점조차 없음)과 기준점만 있는 배열(신규 물건, 아직 변동 없음)
 * 모두 `false`를 반환한다 — design.md Risks가 이 둘을 같게 다루라고 명시한다. 절대
 * `changes.length === 0`로 판정하지 않는다: 그러면 기준점 1건뿐인 물건이 "변동 있음"으로
 * 잘못 표시된다.
 */
export function hasRealChange(changes: ReadonlyArray<Pick<ItemChange, "oldValue">>): boolean {
  return changes.some(isRealChange);
}

/**
 * 목록 행의 `lastChangedAt`이 최근(`RECENT_CHANGE_DAYS`일 이내) 실제 변경인지 판정한다.
 * `lastChangedAt`은 이미 실제 변경만 반영하는 값이다(레포지토리 D6 서브쿼리) — 이 함수는
 * "그 시각이 최근인지"만 본다.
 *
 * @param now 테스트에서 시각을 고정하기 위한 주입 지점. 기본값은 호출 시점의 현재 시각.
 */
export function isRecentlyChanged(
  lastChangedAt: IsoDateTime | null | undefined,
  now: Date = new Date(),
): boolean {
  if (!lastChangedAt) return false;
  const changedAtMs = new Date(lastChangedAt).getTime();
  if (Number.isNaN(changedAtMs)) return false;
  const diff = now.getTime() - changedAtMs;
  return diff >= 0 && diff <= RECENT_CHANGE_MS;
}

export type PriceDirection = "drop" | "rise" | "flat" | "unknown";

export interface PriceChangeDisplay {
  /** `640,000,000원 → 448,000,000원 (-192,000,000원, -30.0%)` 형태의 표시 문자열. */
  text: string;
  direction: PriceDirection;
}

/** `value`가 유한한 숫자로 파싱되면 그 값을, 아니면 `null`을 반환한다. */
function parseFiniteNumber(value: string | null): number | null {
  if (value === null) return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

/**
 * 최저매각가격 변경을 "이전 → 새 값 (증감액, 증감률)" 형태로 만든다.
 *
 * - `oldValue`/`newValue`가 숫자로 파싱되지 않으면(레거시 데이터, 빈 값 등) 증감 계산 없이
 *   원문만 이어붙이고 `direction: "unknown"`을 반환한다 — `NaN`/`Infinity`를 화면에 내보내지
 *   않는다.
 * - `oldValue`가 `"0"`이면 증감률(퍼센트)은 0으로 나누기가 되므로 생략한다. 금액만 표시한다.
 * - 하락(`drop`)과 상승(`rise`)을 구별해서 반환한다 — 하락이 경매 관전자에게 의미 있는
 *   이벤트이므로 화면(CSS)에서 다르게 강조할 수 있게 하기 위함.
 */
export function formatPriceChange(
  oldValue: string | null,
  newValue: string | null,
): PriceChangeDisplay {
  const oldNum = parseFiniteNumber(oldValue);
  const newNum = parseFiniteNumber(newValue);
  const oldText = oldNum !== null ? formatWon(oldNum) : (oldValue ?? EMPTY);
  const newText = newNum !== null ? formatWon(newNum) : (newValue ?? EMPTY);

  if (oldNum === null || newNum === null) {
    return { text: `${oldText} → ${newText}`, direction: "unknown" };
  }

  const delta = newNum - oldNum;
  if (delta === 0) {
    return { text: `${oldText} → ${newText}`, direction: "flat" };
  }

  const direction: PriceDirection = delta < 0 ? "drop" : "rise";
  const sign = delta < 0 ? "-" : "+";
  const deltaText = `${sign}${formatWon(Math.abs(delta))}`;

  // oldNum이 0이면 퍼센트는 0으로 나누기(Infinity)가 되므로 생략한다.
  const percentText =
    oldNum !== 0 ? `, ${sign}${Math.abs((delta / oldNum) * 100).toFixed(1)}%` : "";

  return { text: `${oldText} → ${newText} (${deltaText}${percentText})`, direction };
}

/** 가격 이외의 감시 필드 값을 `field`에 맞는 형식으로 표시한다. `value`가 없으면 `EMPTY`. */
function formatChangeFieldValue(field: WatchedField, value: string | null): string {
  if (value === null) return EMPTY;
  switch (field) {
    case "failedBidCount": {
      const num = Number(value);
      return Number.isFinite(num) ? formatCount(num) : value;
    }
    case "auctionDate":
      // `YYYY-MM-DD`를 `Date`로 파싱하지 않는다 — format.ts의 `formatDate`와 같은 이유
      // (UTC 파싱 시 KST에서 하루 밀림). 문자열을 그대로 formatDate에 넘긴다.
      return formatDate(value);
    case "status":
      return formatText(value);
    case "minBidPrice":
      // formatPriceChange가 별도로 처리한다. 이 분기는 도달하지 않는다.
      return value;
  }
}

export interface ChangeDisplay {
  id: number;
  field: WatchedField;
  label: string;
  text: string;
  direction: PriceDirection | null;
  changedAt: IsoDateTime;
}

/**
 * 실제 변경 이력 한 건을 화면에 표시할 형태로 만든다.
 *
 * 호출 전에 `isRealChange`로 걸러진 행이라고 가정한다(기준점 행을 넘기면 "null → 값"
 * 형태로 나온다 — 기준점은 애초에 이 함수에 넘기지 않는 것이 규약이다).
 */
export function formatChangeDisplay(change: ItemChange): ChangeDisplay {
  const label = WATCHED_FIELD_LABELS[change.field];
  if (change.field === "minBidPrice") {
    const { text, direction } = formatPriceChange(change.oldValue, change.newValue);
    return { id: change.id, field: change.field, label, text, direction, changedAt: change.changedAt };
  }
  const oldText = formatChangeFieldValue(change.field, change.oldValue);
  const newText = formatChangeFieldValue(change.field, change.newValue);
  return {
    id: change.id,
    field: change.field,
    label,
    text: `${oldText} → ${newText}`,
    direction: null,
    changedAt: change.changedAt,
  };
}
