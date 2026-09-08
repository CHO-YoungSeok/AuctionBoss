/**
 * `/feed` 화면이 쓰는 순수 표시 헬퍼(add-bookmarks-and-feed task 4.6).
 *
 * 판단 로직(변동 요약 문구, 미확인 여부)을 JSX 밖으로 뽑아 테스트로 고정한다 — 표시 판단을
 * JSX 조건문에 인라인으로 두면 판단 기준 하나가 조용히 빠져도 테스트가 못 잡는다는 것이
 * 이 프로젝트에서 실제로 있었던 문제다(`change-history.ts` 상단 주석 참고).
 */
import type { FeedEntry } from "@/lib/domain";

import { WATCHED_FIELD_LABELS, formatFieldChange, type PriceDirection } from "./change-history";
import { formatText } from "./format";

export interface FeedEntryDisplay {
  id: number;
  itemId: number;
  /** 링크·표시용 소재지. 물건이 소재지 없이 저장됐으면 `EMPTY`("-"). */
  itemAddress: string;
  label: string;
  text: string;
  direction: PriceDirection | null;
  changedAt: string;
}

/**
 * 피드 항목 한 건을 화면에 표시할 형태로 만든다.
 *
 * `formatFieldChange`(change-history.ts)를 그대로 재사용한다 — 물건 상세의 변경 이력과
 * 피드가 같은 `field`/`oldValue`/`newValue` 값을 다른 문구 규칙으로 보여주면(예: 상세는
 * 하락을 빨간색으로 강조하는데 피드는 안 하는 식) 사용자가 같은 정보를 두 화면에서 다르게
 * 읽게 된다.
 */
export function formatFeedEntryDisplay(entry: FeedEntry): FeedEntryDisplay {
  const label = WATCHED_FIELD_LABELS[entry.field];
  const { text, direction } = formatFieldChange(entry.field, entry.oldValue, entry.newValue);
  return {
    id: entry.id,
    itemId: entry.itemId,
    itemAddress: formatText(entry.itemAddress),
    label,
    text,
    direction,
    changedAt: entry.changedAt,
  };
}

/**
 * 피드의 한 항목이 미확인인지 판정한다.
 *
 * 저장소(`bookmarks.ts`)는 항목별 읽음 플래그를 두지 않는다(design.md D3 — 미확인 개수는
 * `changed_at > last_read_at`으로 매번 도출되는 값이지 저장된 값이 아니다). 대신
 * `listFeed`가 항상 `changed_at DESC`로 정렬해서 돌려준다는 보장 하나로 항목별 미확인
 * 여부를 계산할 수 있다: `changed_at > last_read_at`인 행은 전부 그렇지 않은 행보다 앞에
 * 오므로(내림차순 정렬이 경계를 자르지 않는다 — 같은 `changed_at`을 가진 행은 전부 경계의
 * 같은 쪽에 있다), 정렬된 피드에서 앞에서부터 `unreadCount`번째까지가 정확히 미확인
 * 항목이다. 페이지네이션을 가로질러도 성립하므로 `(page-1)*pageSize + 페이지 내 인덱스`로
 * 전역 순번을 구해 `unreadCount`와 비교하면 된다 — API에 새 필드를 추가하지 않고 이미
 * 있는 `unreadCount`와 정렬 보장만으로 판정한다.
 */
export function isFeedEntryUnread(params: {
  page: number;
  pageSize: number;
  indexOnPage: number;
  unreadCount: number;
}): boolean {
  const globalRank = (params.page - 1) * params.pageSize + params.indexOnPage;
  return globalRank < params.unreadCount;
}
