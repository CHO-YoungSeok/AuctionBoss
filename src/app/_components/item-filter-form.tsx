/**
 * 목록 페이지의 필터·정렬 폼.
 *
 * **평범한 `<form method="get">`이다.** 클라이언트 JS가 한 줄도 없다:
 * 브라우저가 폼을 URL 쿼리스트링으로 직렬화해 GET으로 보내고, 서버 컴포넌트가 그 URL을
 * 다시 파싱한다. 그래서 "적용된 필터가 URL에 반영되고 그 URL을 다시 열면 같은 결과가
 * 나온다"는 요구사항이 별도 상태 관리 없이 그냥 성립한다.
 *
 * 특히 체크박스 그룹은 같은 `name="usage"`를 여러 번 보내는 것이 HTML 기본 동작이라,
 * 우리가 필요한 반복 파라미터 형태(`usage=a&usage=b`)가 공짜로 나온다 (design.md D4).
 *
 * `defaultChecked`/`defaultValue`를 쓰는 이유: `checked`/`value`를 쓰면 React가 제어
 * 컴포넌트로 보고 `onChange` 경고를 낸다. 여기서는 초기값만 심고 이후는 브라우저에 맡긴다.
 */
import Link from "next/link";

import {
  DEFAULT_PAGE_SIZE,
  DEFAULT_SORT_DIRECTION,
  DEFAULT_SORT_KEY,
  SORT_DIRECTIONS,
  SORT_KEYS,
  hasActiveFilters,
  type ItemQuery,
} from "@/lib/domain";

import { DIRECTION_LABELS, SORT_LABELS } from "../_lib/format";
import { ITEM_LIST_PATH } from "../_lib/item-query-url";

export function ItemFilterForm({
  query,
  usageTypes,
}: {
  /** lenient 파서가 만든 현재 조건. 폼의 초기값이 된다. */
  query: ItemQuery;
  /** 저장된 데이터에서 도출된 용도 목록(`listUsageTypes()`). 고정 목록이 아니다. */
  usageTypes: string[];
}) {
  const selectedUsage = new Set(query.usageTypes ?? []);

  return (
    <form className="filters" method="get" action={ITEM_LIST_PATH}>
      {/*
        `page`는 일부러 폼에 넣지 않는다 — 조건을 바꾸면 1페이지부터 봐야 한다.
        반대로 폼에 입력칸이 없지만 URL에 실려 온 조건은 hidden으로 들고 가야 제출 때
        조용히 사라지지 않는다.
      */}
      {query.analyzed !== undefined ? (
        <input type="hidden" name="analyzed" value={String(query.analyzed)} />
      ) : null}
      {query.pageSize !== undefined && query.pageSize !== DEFAULT_PAGE_SIZE ? (
        <input type="hidden" name="pageSize" value={String(query.pageSize)} />
      ) : null}

      {usageTypes.length > 0 ? (
        <fieldset className="filter-group">
          <legend>용도</legend>
          <div className="checkbox-list">
            {usageTypes.map((usageType) => (
              <label key={usageType} className="checkbox">
                <input
                  type="checkbox"
                  name="usage"
                  value={usageType}
                  defaultChecked={selectedUsage.has(usageType)}
                />
                <span>{usageType}</span>
              </label>
            ))}
          </div>
        </fieldset>
      ) : null}

      <div className="filter-row">
        <label className="filter-field">
          <span>최저매각가격 최소</span>
          <input
            type="number"
            name="minPrice"
            min={0}
            step={1}
            inputMode="numeric"
            placeholder="원"
            defaultValue={query.minPrice ?? ""}
          />
        </label>
        <label className="filter-field">
          <span>최저매각가격 최대</span>
          <input
            type="number"
            name="maxPrice"
            min={0}
            step={1}
            inputMode="numeric"
            placeholder="원"
            defaultValue={query.maxPrice ?? ""}
          />
        </label>
        <label className="filter-field">
          <span>유찰횟수 최소</span>
          <input
            type="number"
            name="minFailed"
            min={0}
            step={1}
            inputMode="numeric"
            placeholder="회"
            defaultValue={query.minFailedBidCount ?? ""}
          />
        </label>
        <label className="filter-field">
          <span>소재지 키워드</span>
          <input
            type="text"
            name="q"
            placeholder="예: 강남"
            defaultValue={query.addressKeyword ?? ""}
          />
        </label>
        <label className="filter-field">
          <span>정렬 기준</span>
          <select name="sort" defaultValue={query.sort ?? DEFAULT_SORT_KEY}>
            {SORT_KEYS.map((key) => (
              <option key={key} value={key}>
                {SORT_LABELS[key]}
              </option>
            ))}
          </select>
        </label>
        <label className="filter-field">
          <span>정렬 방향</span>
          <select name="dir" defaultValue={query.direction ?? DEFAULT_SORT_DIRECTION}>
            {SORT_DIRECTIONS.map((direction) => (
              <option key={direction} value={direction}>
                {DIRECTION_LABELS[direction]}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="filter-actions">
        <button type="submit">필터 적용</button>
        {/*
          링크로 두는 이유: 초기화는 "조건 없는 URL을 여는 것"이지 폼 제출이 아니다.
          `<a>`면 JS 없이 동작하고 새 탭으로 열 수도 있다.
        */}
        {hasActiveFilters(query) ? (
          <Link className="reset-link" href={ITEM_LIST_PATH}>
            필터 초기화
          </Link>
        ) : null}
      </div>
    </form>
  );
}
