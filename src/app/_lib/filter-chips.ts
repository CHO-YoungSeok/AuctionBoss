/**
 * 적용 중인 필터를 칩으로 표시하기 위한 순수 판정(ux-overhaul-phase2 design.md D5,
 * tasks.md 7.1/7.4).
 *
 * "표시 판정이 JSX에 인라인돼 있다가 버그로 발견된 적이 있다"는 이 프로젝트의 경고
 * (`item-extensions.ts`/`change-history.ts` 등의 선례, CLAUDE.md)를 따라 어떤 칩이
 * 보이고 어떤 라벨을 갖는지를 컴포넌트 밖으로 뺀다. 실제 해제 링크(href)는 여기서
 * 만들지 않는다 — 호출부(`page.tsx`)가 `itemListHref(query, chip.clear)`를 직접
 * 부른다(design.md D5: "새 함수를 만들지 않는다", 기존 `itemListHref`를 그대로 쓴다).
 */
import type { ItemQuery } from "@/lib/domain";

import { formatWonAsEokMan } from "./format";

export interface FilterChip {
  /** React key이자 디버깅용 식별자. */
  key: string;
  label: string;
  /** `itemListHref(query, clear)`에 그대로 넘길 override — 이 필드(들)만 지운다. */
  clear: Partial<ItemQuery>;
}

function joinValues(values: string[]): string {
  return values.join(", ");
}

/**
 * `hasActiveFilters`와 같은 필드 집합을 다뤄야 한다 — 여기서 빠진 필드는 칩으로 안
 * 보이지만 결과는 좁아진 채로 남는 모순이 생긴다. 새 필터를 추가하면 이 함수도 같이
 * 고친다(tasks.md 0번 체크리스트의 연장).
 */
export function buildFilterChips(query: ItemQuery): FilterChip[] {
  const chips: FilterChip[] = [];

  if (query.sidoValues !== undefined && query.sidoValues.length > 0) {
    chips.push({
      key: "sido",
      label: `시/도: ${joinValues(query.sidoValues)}`,
      clear: { sidoValues: undefined },
    });
  }
  if (query.sigunguValues !== undefined && query.sigunguValues.length > 0) {
    chips.push({
      key: "sigungu",
      label: `시/군/구: ${joinValues(query.sigunguValues)}`,
      clear: { sigunguValues: undefined },
    });
  }
  if (query.usageTypes !== undefined && query.usageTypes.length > 0) {
    chips.push({
      key: "usage",
      label: `용도: ${joinValues(query.usageTypes)}`,
      clear: { usageTypes: undefined },
    });
  }
  if (query.minPrice !== undefined || query.maxPrice !== undefined) {
    const min = query.minPrice !== undefined ? formatWonAsEokMan(query.minPrice) : null;
    const max = query.maxPrice !== undefined ? formatWonAsEokMan(query.maxPrice) : null;
    const label =
      min !== null && max !== null
        ? `가격: ${min} ~ ${max}`
        : min !== null
          ? `가격: ${min} 이상`
          : `가격: ${max} 이하`;
    // 최소·최대는 한 필터 하나로 취급한다 — 폼에도 "가격" 하나로 묶여 있고, 해제도
    // 함께 한다(한쪽만 남기면 사용자가 지정하지 않은 범위를 만들어 낸다).
    chips.push({ key: "price", label, clear: { minPrice: undefined, maxPrice: undefined } });
  }
  if (query.minFailedBidCount !== undefined) {
    chips.push({
      key: "minFailed",
      label: `유찰 ${query.minFailedBidCount}회 이상`,
      clear: { minFailedBidCount: undefined },
    });
  }
  if (query.addressKeyword !== undefined && query.addressKeyword !== "") {
    chips.push({
      key: "q",
      label: `소재지: ${query.addressKeyword}`,
      clear: { addressKeyword: undefined },
    });
  }
  if (query.auctionDateFrom !== undefined || query.auctionDateTo !== undefined) {
    const from = query.auctionDateFrom ?? null;
    const to = query.auctionDateTo ?? null;
    const label =
      from !== null && to !== null
        ? `기일: ${from} ~ ${to}`
        : from !== null
          ? `기일: ${from} 이후`
          : `기일: ${to} 이전`;
    chips.push({
      key: "auctionDateRange",
      label,
      clear: { auctionDateFrom: undefined, auctionDateTo: undefined },
    });
  }
  if (query.excludePastAuctions !== undefined) {
    chips.push({
      key: "excludePastAuctions",
      label: "지난 기일 제외",
      clear: { excludePastAuctions: undefined },
    });
  }
  if (query.bookmarked !== undefined) {
    chips.push({
      key: "bookmarked",
      label: query.bookmarked ? "관심만 보기" : "관심 제외",
      clear: { bookmarked: undefined },
    });
  }
  if (query.analyzed !== undefined) {
    chips.push({
      key: "analyzed",
      label: query.analyzed ? "분석 완료만" : "분석 전만",
      clear: { analyzed: undefined },
    });
  }
  if (query.court !== undefined) {
    chips.push({
      key: "court",
      label: `법원: ${query.court}`,
      clear: { court: undefined },
    });
  }
  if (query.minDiscountRate !== undefined) {
    chips.push({
      key: "minDiscountRate",
      label: `저감률: ${query.minDiscountRate}% 이상`,
      clear: { minDiscountRate: undefined },
    });
  }
  if (query.hasPhotos !== undefined) {
    chips.push({
      key: "hasPhotos",
      label: query.hasPhotos ? "사진 있음" : "사진 없음",
      clear: { hasPhotos: undefined },
    });
  }

  return chips;
}
