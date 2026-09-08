/**
 * 목록 페이지의 필터·정렬 폼.
 *
 * **평범한 `<form method="get">`이다.** 클라이언트 JS가 한 줄도 없다:
 * 브라우저가 폼을 URL 쿼리스트링으로 직렬화해 GET으로 보내고, 서버 컴포넌트가 그 URL을
 * 다시 파싱한다. 그래서 "적용된 필터가 URL에 반영되고 그 URL을 다시 열면 같은 결과가
 * 나온다"는 요구사항이 별도 상태 관리 없이 그냥 성립한다.
 *
 * 특히 체크박스 그룹은 같은 `name="usage"`(또는 `sido`/`sigungu`)를 여러 번 보내는 것이
 * HTML 기본 동작이라, 우리가 필요한 반복 파라미터 형태(`usage=a&usage=b`)가 공짜로
 * 나온다 (design.md D4/D1).
 *
 * `defaultChecked`/`defaultValue`를 쓰는 이유: `checked`/`value`를 쓰면 React가 제어
 * 컴포넌트로 보고 `onChange` 경고를 낸다. 여기서는 초기값만 심고 이후는 브라우저에 맡긴다.
 *
 * ux-overhaul-phase2 tasks.md 7.2: 폼 전체를 `<details>`로 감싸 접는다(필터가 걸려 있으면
 * 펼침) — 클라이언트 JS 없이 접기/펼치기가 필요해서 물건 상세 페이지의 "이전 분석"과 같은
 * 네이티브 `<details>/<summary>` 선례를 따른다. 열림 여부 판단은 새 함수를 만들지 않고
 * 기존 `hasActiveFilters`를 그대로 쓴다(design.md D5).
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

import { DIRECTION_LABELS, SORT_LABELS, formatWonAsEokMan } from "../_lib/format";
import { ITEM_LIST_PATH, itemListHref } from "../_lib/item-query-url";
import { PRICE_PRESETS, wonToEokManParts } from "../_lib/price-input";

/** 페이지 크기 선택지(tasks.md 7.3). `DEFAULT_PAGE_SIZE`(20)를 포함하고 `MAX_PAGE_SIZE`
 * (200) 이하로 유지한다. */
const PAGE_SIZE_OPTIONS = [10, 20, 50, 100, 200] as const;

export function ItemFilterForm({
  query,
  usageTypes,
  sidoValues,
  sigunguValues,
}: {
  /** lenient 파서가 만든 현재 조건. 폼의 초기값이 된다. */
  query: ItemQuery;
  /** 저장된 데이터에서 도출된 용도 목록(`listUsageTypes()`). 고정 목록이 아니다. */
  usageTypes: string[];
  /** 저장된 데이터에서 도출된 시/도 목록(`listSidoValues()`). 고정 목록이 아니다(tasks.md 1.2). */
  sidoValues: string[];
  /** 저장된 데이터에서 도출된 시/군/구 목록(`listSigunguValues()`). */
  sigunguValues: string[];
}) {
  const selectedUsage = new Set(query.usageTypes ?? []);
  const selectedSido = new Set(query.sidoValues ?? []);
  const selectedSigungu = new Set(query.sigunguValues ?? []);
  const minParts = wonToEokManParts(query.minPrice);
  const maxParts = wonToEokManParts(query.maxPrice);
  const filtersActive = hasActiveFilters(query);

  return (
    <details className="filters-details" open={filtersActive}>
      <summary>필터·정렬{filtersActive ? " (적용 중)" : ""}</summary>
      <form className="filters" method="get" action={ITEM_LIST_PATH}>
        {/*
          `page`는 일부러 폼에 넣지 않는다 — 조건을 바꾸면 1페이지부터 봐야 한다.
          반대로 폼에 입력칸이 없지만 URL에 실려 온 조건은 hidden으로 들고 가야 제출 때
          조용히 사라지지 않는다.
        */}
        {query.analyzed !== undefined ? (
          <input type="hidden" name="analyzed" value={String(query.analyzed)} />
        ) : null}

        {sidoValues.length > 0 ? (
          <fieldset className="filter-group">
            <legend>시/도</legend>
            <div className="checkbox-list">
              {sidoValues.map((sido) => (
                <label key={sido} className="checkbox">
                  <input
                    type="checkbox"
                    name="sido"
                    value={sido}
                    defaultChecked={selectedSido.has(sido)}
                  />
                  <span>{sido}</span>
                </label>
              ))}
            </div>
          </fieldset>
        ) : null}

        {sigunguValues.length > 0 ? (
          <fieldset className="filter-group">
            <legend>시/군/구</legend>
            <div className="checkbox-list">
              {sigunguValues.map((sigungu) => (
                <label key={sigungu} className="checkbox">
                  <input
                    type="checkbox"
                    name="sigungu"
                    value={sigungu}
                    defaultChecked={selectedSigungu.has(sigungu)}
                  />
                  <span>{sigungu}</span>
                </label>
              ))}
            </div>
          </fieldset>
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

        {/* 가격(tasks.md 2.1~2.4) — 억/만원 두 칸으로 입력받아 서버가 원 단위로 합산한다
            (design.md D3). 원 단위 파라미터(minPrice/maxPrice)가 URL에 직접 오면 그쪽이
            이긴다 — 이 폼은 항상 억/만원 칸만 제출하므로 그 경우는 생기지 않는다. */}
        <fieldset className="filter-group">
          <legend>최저매각가격</legend>
          <p className="muted">
            현재 조건: {query.minPrice !== undefined ? formatWonAsEokMan(query.minPrice) : "제한 없음"}
            {" ~ "}
            {query.maxPrice !== undefined ? formatWonAsEokMan(query.maxPrice) : "제한 없음"}
          </p>
          <div className="filter-row">
            <label className="filter-field">
              <span>최소 억</span>
              <input type="number" name="minEok" min={0} step={1} inputMode="numeric" defaultValue={minParts.eok || ""} />
            </label>
            <label className="filter-field">
              <span>최소 만원</span>
              <input type="number" name="minMan" min={0} step={1} inputMode="numeric" defaultValue={minParts.man || ""} />
            </label>
            <label className="filter-field">
              <span>최대 억</span>
              <input type="number" name="maxEok" min={0} step={1} inputMode="numeric" defaultValue={maxParts.eok || ""} />
            </label>
            <label className="filter-field">
              <span>최대 만원</span>
              <input type="number" name="maxMan" min={0} step={1} inputMode="numeric" defaultValue={maxParts.man || ""} />
            </label>
          </div>
          {/* 프리셋(tasks.md 2.3) — 단순 링크다. 이미 계산된 원 단위 값이 URL에 담긴다. */}
          <div className="price-presets">
            {PRICE_PRESETS.map((preset) => (
              <Link
                key={preset.label}
                className="price-preset-link"
                href={itemListHref(query, {
                  minPrice: preset.minPrice,
                  maxPrice: preset.maxPrice,
                  page: undefined,
                })}
              >
                {preset.label}
              </Link>
            ))}
          </div>
        </fieldset>

        <div className="filter-row">
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
          {/* 매각기일 범위(tasks.md 3.1~3.2) — from/to는 그대로 선택적이고, "지난 기일
              제외"는 체크박스다. 체크박스는 안 누르면 아예 제출되지 않으므로(HTML 기본
              동작) opt-in이 자연스럽게 지켜진다 — 기본값을 만들 방법이 없다. */}
          <label className="filter-field">
            <span>매각기일 시작</span>
            <input type="date" name="dateFrom" defaultValue={query.auctionDateFrom ?? ""} />
          </label>
          <label className="filter-field">
            <span>매각기일 종료</span>
            <input type="date" name="dateTo" defaultValue={query.auctionDateTo ?? ""} />
          </label>
          <label className="checkbox filter-field">
            <input
              type="checkbox"
              name="excludePast"
              value="true"
              defaultChecked={query.excludePastAuctions === true}
            />
            <span>지난 기일 제외</span>
          </label>
          <label className="filter-field">
            <span>관심 물건</span>
            <select name="bookmarked" defaultValue={query.bookmarked === undefined ? "" : String(query.bookmarked)}>
              <option value="">전체</option>
              <option value="true">관심만 보기</option>
              <option value="false">관심 제외</option>
            </select>
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
          <label className="filter-field">
            <span>페이지 크기</span>
            <select name="pageSize" defaultValue={String(query.pageSize ?? DEFAULT_PAGE_SIZE)}>
              {PAGE_SIZE_OPTIONS.map((size) => (
                <option key={size} value={size}>
                  {size}건
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
          {filtersActive ? (
            <Link className="reset-link" href={ITEM_LIST_PATH}>
              필터 초기화
            </Link>
          ) : null}
        </div>
      </form>
    </details>
  );
}
