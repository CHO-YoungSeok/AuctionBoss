/**
 * `ItemQuery` → 목록 페이지 URL 직렬화.
 *
 * 페이지네이션 링크가 필터를 떨어뜨리는 것이 이 화면에서 가장 흔한 버그라, 링크를
 * 손으로 조립하지 않고 **현재 적용된 조건 객체 하나에서** 만든다. lenient 파서가 만든
 * `ItemQuery`를 그대로 되돌리므로 "링크를 눌러 이동 → 다시 파싱"이 같은 조건으로
 * 왕복한다(정규화 왕복이라, URL에 있던 잘못된 값은 링크에 실려 퍼지지 않는다).
 *
 * `usage`는 **반복 파라미터**다(`usage=a&usage=b`). 실제 용도 문자열에 쉼표가 들어 있어
 * (`"상가,오피스텔,근린시설"`) 쉼표로 합칠 수 없다 — 자세한 근거는
 * `src/lib/domain/item-query.ts`의 `MULTI_VALUE_PARAMS` 주석 참조.
 * 그래서 `set`이 아니라 값마다 `append`한다.
 */
import { itemQuerySearchParams, type ItemQuery } from "@/lib/domain";

// 직렬화는 도메인으로 옮겼다(switch-web-to-data-port 1.5) — Spring 구현체도 같은 규칙을 쓴다.
export { itemQuerySearchParams };

/** 목록 페이지 경로. 필터를 모두 버린 "초기화" 링크이기도 하다. */
export const ITEM_LIST_PATH = "/";

/**
 * 목록 페이지 링크. `overrides`로 일부 조건만 바꿔 나머지는 전부 유지한다
 * (페이지네이션은 `{ page }`만 바꿔 필터·정렬을 그대로 들고 간다).
 */
export function itemListHref(query: ItemQuery, overrides?: Partial<ItemQuery>): string {
  // 화면 URL로 들어온 `needsAnalysis`·`promptVersion`은 파서가 읽지만(워커 전용 조건) 링크로는
  // 왕복하지 않는다 — 이전 동작 그대로 링크에서 버린다. 도메인 직렬화는 이 필드를 던지게 하므로
  // 여기서 먼저 제거하지 않으면 `/?needsAnalysis=true&promptVersion=x`가 500이 된다.
  const serializable: ItemQuery = { ...query, ...overrides };
  delete serializable.needsAnalysis;
  delete serializable.promptVersion;
  delete serializable.reanalysisCooldownHours;
  const params = itemQuerySearchParams(serializable);
  const search = params.toString();
  return search === "" ? ITEM_LIST_PATH : `${ITEM_LIST_PATH}?${search}`;
}
