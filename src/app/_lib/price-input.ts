/**
 * 가격 필터 폼(억/만원 입력)이 쓰는 순수 헬퍼(ux-overhaul-phase2 tasks.md 2.1/2.3).
 *
 * 폼은 원 단위 숫자 입력 대신 억/만원 두 칸을 받는다 — 실데이터가 76만원~261억까지
 * 걸쳐 있어(proposal.md) 원 단위 11자리 입력은 0 하나만 틀려도 조용히 10배 다른 결과를
 * 낸다. 서버가 두 칸을 합산해 `minPrice`/`maxPrice`(원 정수, 기존 API 계약)로 바꾸는
 * 로직은 도메인(`src/lib/domain/item-query.ts`의 `effectivePriceBound`)에 있다 — 이
 * 파일은 그 반대 방향(폼의 초기값을 채우기 위해 저장된 원 단위 값을 억/만원으로
 * 쪼개는 것)과, 자주 쓰는 가격대 프리셋만 다룬다.
 */
import { WON_PER_EOK, WON_PER_MAN, type Won } from "@/lib/domain";

export interface EokManParts {
  eok: number;
  man: number;
}

/**
 * 저장된 원 단위 값을 폼의 억/만원 입력칸 초기값으로 쪼갠다. `formatWonAsEokMan`(표시)과
 * 달리 만원 미만 잔액은 버린다 — 입력칸은 정수 두 칸뿐이라 표시할 자리가 없고, 애초에
 * 사람이 억/만원 단위로 입력한 값을 다시 보여주는 용도라 잔액이 생기는 경우는 드물다
 * (URL을 손으로 만든 극단적인 경우뿐이다).
 */
export function wonToEokManParts(won: Won | undefined): EokManParts {
  if (won === undefined || !Number.isFinite(won) || won <= 0) return { eok: 0, man: 0 };
  const abs = Math.floor(won);
  return { eok: Math.floor(abs / WON_PER_EOK), man: Math.floor((abs % WON_PER_EOK) / WON_PER_MAN) };
}

export interface PricePreset {
  label: string;
  minPrice: Won | undefined;
  maxPrice: Won | undefined;
}

/**
 * 자주 쓰는 가격대(tasks.md 2.3). 링크는 이미 계산된 원 단위 값을 URL에 담는 단순 링크다
 * — `minPrice`/`maxPrice`는 항상 두 키 다 명시한다(값이 없는 쪽도 `undefined`로) —
 * `itemListHref(query, preset)`가 스프레드로 병합할 때 이전 가격 조건을 확실히 덮어써야
 * 하기 때문이다(생략하면 기존 값이 남아 프리셋과 뒤섞인다).
 */
export const PRICE_PRESETS: readonly PricePreset[] = [
  { label: "1억 이하", minPrice: undefined, maxPrice: 1 * WON_PER_EOK },
  { label: "1~3억", minPrice: 1 * WON_PER_EOK, maxPrice: 3 * WON_PER_EOK },
  { label: "3~5억", minPrice: 3 * WON_PER_EOK, maxPrice: 5 * WON_PER_EOK },
  { label: "5~10억", minPrice: 5 * WON_PER_EOK, maxPrice: 10 * WON_PER_EOK },
  { label: "10억+", minPrice: 10 * WON_PER_EOK, maxPrice: undefined },
];
