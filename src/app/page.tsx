/**
 * 물건 목록 페이지(홈).
 *
 * 서버 컴포넌트에서 저장소를 직접 읽는다 — 자기 자신의 API를 fetch하면 같은 프로세스 안에서
 * 왕복 HTTP 요청이 한 번 더 생길 뿐 얻는 게 없다.
 *
 * 파라미터는 **lenient 파서**로 읽는다(`parseItemQueryLenient`). API가 잘못된 값을 400으로
 * 거절하는 것과 의도적으로 다르다 (design.md D4): 워커 같은 API 클라이언트는 오타를 알아야
 * 하지만, 사람이 URL을 손으로 고쳤을 때 화면이 에러로 죽는 것은 나쁘다. 그래서
 * `?sort=nope&minPrice=abc&page=0` 같은 URL도 평범한 1페이지 기본 정렬 화면이 된다.
 */
import Link from "next/link";

import { getRepository, getUnreadCount, getWorkerStatus } from "@/lib/db";
import {
  DEFAULT_SORT_DIRECTION,
  DEFAULT_SORT_KEY,
  chooseEmptyState,
  hasActiveFilters,
  parseItemQueryLenient,
} from "@/lib/domain";

import { BookmarkToggleForm } from "./_components/bookmark-toggle-form";
import { ItemFilterForm } from "./_components/item-filter-form";
import { formatMismatchDescription, detectFailedBidRateMismatch } from "./_lib/bid-mismatch";
import { isRecentlyChanged } from "./_lib/change-history";
import { buildCollectionBanner, formatCoverage, shouldWarnCollection } from "./_lib/collection-banner";
import { computeDDay, formatDDay } from "./_lib/d-day";
import {
  DISCOUNT_STAGE_LABELS,
  classifyDiscountStage,
  computeDiscountRatio,
  formatDiscountRatio,
} from "./_lib/discount";
import {
  DIRECTION_LABELS,
  EMPTY,
  SORT_LABELS,
  formatCount,
  formatDate,
  formatDateTime,
  formatText,
  formatWon,
} from "./_lib/format";
import { formatAreaRange, computePricePerArea, formatPricePerArea } from "./_lib/item-extensions";
import { ITEM_LIST_PATH, itemListHref } from "./_lib/item-query-url";
import { NOTE_FLAG_LABELS, detectNoteFlags } from "./_lib/note-flags";
import { formatRegionSummary } from "./_lib/region-summary";

// 수집기가 새로 넣은 데이터가 바로 보여야 하므로 정적 프리렌더를 끈다.
// (이게 없으면 `next build`가 빌드 시점에 DB를 열어 페이지를 미리 렌더한다.)
export const dynamic = "force-dynamic";

export default async function ItemListPage({
  searchParams,
}: {
  // Next.js 15에서 페이지의 searchParams는 Promise다.
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  // 잘못된 파라미터는 여기서 버려지고 기본값으로 복구된다. 아래 링크·폼은 전부 이
  // 정규화된 `query`에서 만들어지므로, URL의 쓰레기 값이 화면의 링크로 퍼지지 않는다.
  const query = parseItemQueryLenient(params);

  const repository = getRepository();
  // 용도 선택지는 저장된 데이터에서 도출한다 — 하드코딩하지 않는다 (design.md D3).
  const usageTypes = repository.listUsageTypes();
  const { items, total, page, pageSize } = repository.listItems(query);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  // 관심 토글 폼(각 행)이 제출 후 돌아갈 경로 — 지금 보고 있는 이 목록 URL 그대로다
  // (design.md D5, spec: "등록 후 화면 복귀"). `itemListHref`가 정규화된 `query` 하나에서
  // 만들어 주므로 필터·정렬·페이지가 빠지지 않는다.
  const currentListHref = itemListHref(query);
  // 피드로 가는 링크에 미확인 개수를 노출한다(task 4.5) — 접근 경로가 없으면 아무도
  // 보지 않는다는 design.md의 지적과 같은 이유.
  const unreadCount = getUnreadCount();

  const filtersActive = hasActiveFilters(query);
  // "DB 자체가 비었다"와 "필터에 걸리는 물건이 없다"는 사용자에게 전혀 다른 상황이라
  // 안내 문구도, 다음에 할 행동(수집을 기다린다 / 조건을 고친다)도 달라야 한다.
  // 판단 자체는 순수 함수(`chooseEmptyState`)에 있다 — JSX 조건문에 흩어 두면
  // 필터 하나가 판단 기준에서 빠져도(예: `analyzed`가 그랬다) 테스트가 잡아내지 못한다.
  const emptyState = chooseEmptyState(total, query);
  const databaseEmpty = emptyState.kind === "emptyDatabase";

  const sortLabel = SORT_LABELS[query.sort ?? DEFAULT_SORT_KEY];
  const directionLabel = DIRECTION_LABELS[query.direction ?? DEFAULT_SORT_DIRECTION];
  // 행마다 새로 만들지 않고 렌더링 시작 시점 하나로 고정한다 — 표시 목적으로만 쓰이므로
  // (design.md D6) 오차는 무의미하지만, 렌더 중 시각이 흔들리지 않는 편이 이해하기 쉽다.
  const now = new Date();

  // 신선도·커버리지 배너(design.md D6, tasks.md 7.1~7.2/7.4) — 새 쿼리를 만들지 않는다.
  // `getWorkerStatus`는 `/status`가 이미 쓰는 함수를 그대로 재사용하고, 분석 커버리지는
  // `listItems({analyzed:true})`(기존 파라미터)로 얻는다. `pageSize: 1`로 행은 최소한만
  // 받고 `total`(별도 COUNT 쿼리, 필터와 무관하게 항상 계산됨)만 쓴다. 분모(전체 건수)는
  // 현재 화면의 필터와 무관하게 DB 전체 기준이어야 "분석 N/389건"이 실제 전체 대비로
  // 읽힌다 — 그래서 `query`가 아니라 빈 조건으로 별도 호출한다.
  const collectorStatus = getWorkerStatus("collector", { now: now.toISOString() });
  const totalItemCount = repository.listItems({ pageSize: 1 }).total;
  const analyzedItemCount = repository.listItems({ analyzed: true, pageSize: 1 }).total;
  const collectionBanner = buildCollectionBanner({
    collectorStatus,
    analyzedCount: analyzedItemCount,
    totalCount: totalItemCount,
  });
  const collectionWarning = shouldWarnCollection(collectionBanner.collectorState);

  return (
    <main className="page">
      <header className="page-header">
        <h1>물건 목록</h1>
        <p className="muted">
          {total > 0
            ? `${filtersActive ? "조건에 맞는 물건 " : "전체 "}${total.toLocaleString("ko-KR")}건 · ${sortLabel} ${directionLabel}`
            : null}
        </p>
        {/* 상태 화면으로 가는 경로(add-collection-observability task 5.4) — 접근 경로가
            없으면 아무도 보지 않는다. */}
        <p className="muted">
          <Link href="/status">워커 상태 보기 →</Link>
        </p>
        {/* 관심 물건·변동 피드로 가는 경로(add-bookmarks-and-feed task 4.5). 미확인
            개수를 여기서 바로 보여준다 — 피드를 열어야만 몇 건인지 아는 것보다, 목록에서
            먼저 보이는 편이 실제로 쓰인다. */}
        <p className="muted">
          <Link href="/bookmarks">관심 물건 보기 →</Link>
          {" · "}
          <Link href="/feed">
            변동 피드 보기{unreadCount > 0 ? ` (미확인 ${unreadCount.toLocaleString("ko-KR")}건)` : ""} →
          </Link>
        </p>
      </header>

      {/* 신선도·커버리지 배너(design.md D6, spec: "신선도와 커버리지") — 분석이 전체의
          일부뿐인데 목록 어디에도 그 사실이 없어 상세를 열어야만 알 수 있었다. 수집이
          차단·정지 상태면 낡은 가격을 아무 일 없다는 얼굴로 보여주지 않도록 경고 색으로
          바뀐다(spec: "수집이 차단되었거나 오래 멈춘 상태면 목록에서 그 사실을 알 수
          있어야 한다"). */}
      <p className={collectionWarning ? "collection-banner collection-banner-warning" : "collection-banner"}>
        마지막 수집: {formatDateTime(collectionBanner.lastCollectedAt)}
        {collectionBanner.targetCourts.length > 0
          ? ` · 대상 법원: ${collectionBanner.targetCourts.join(", ")}`
          : ""}
        {" · "}
        {formatCoverage(collectionBanner)}
        {collectionWarning ? " · 수집이 차단되었거나 오래 멈췄습니다 — 가격이 최신이 아닐 수 있습니다." : ""}
      </p>

      {databaseEmpty ? null : <ItemFilterForm query={query} usageTypes={usageTypes} />}

      {total === 0 ? (
        databaseEmpty ? (
          <p className="empty">아직 수집된 물건이 없습니다.</p>
        ) : (
          <p className="empty">
            조건에 맞는 물건이 없습니다.{" "}
            <Link href={ITEM_LIST_PATH}>필터 초기화</Link>
          </p>
        )
      ) : (
        <>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  {/* 지역 요약(design.md D5) — 구조화 소재지(sido/sigungu/dong)가 있으면
                      그걸 앞세운 짧은 표기, 없으면 기존 address 그대로(formatRegionSummary). */}
                  <th>소재지</th>
                  <th>용도</th>
                  <th className="num">감정가</th>
                  <th className="num">최저매각가격</th>
                  {/* 판단 지표(design.md D1) — 분석을 기다리지 않고도 1차 선별이 가능하도록
                      감정가 대비 최저가 비율과 면적당 가격을 추가한다. 목록 쿼리의
                      WHERE/ORDER BY는 건드리지 않는다 — 표시만 추가한다. */}
                  <th className="num">저감률</th>
                  {/* ux-overhaul-phase1 design.md Risks: "새 열은 만들지 않는다" — 면적
                      병기(spec: "면적 평 병기")가 새로 필요해졌지만 새 <th>를 추가하지
                      않고, 기존 "면적당 가격" 열 안에 면적(㎡·평)과 면적당 가격을 함께
                      쌓아 보여준다. */}
                  <th className="num">면적</th>
                  <th>매각기일</th>
                  <th className="num">유찰횟수</th>
                  <th>진행상태</th>
                  <th>관심</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => {
                  // 계산 불가한 물건은 "-"로 표시되고 행 전체는 정상 렌더링된다(spec: "지표를
                  // 계산할 수 없는 물건"). ratio가 null이면 stage도 항상 null이다
                  // (classifyDiscountStage 계약) — 아래 JSX가 둘 다 확인한다.
                  const discountRatio = computeDiscountRatio(item);
                  const discountStage = classifyDiscountStage(discountRatio);
                  const pricePerArea = computePricePerArea(item);
                  const noteFlags = detectNoteFlags(item);
                  const mismatch = detectFailedBidRateMismatch(item);
                  const dDay = computeDDay(item.auctionDate, now);

                  return (
                    <tr key={item.id}>
                      <td>
                        <Link href={`/items/${item.id}`}>{formatRegionSummary(item)}</Link>
                        {isRecentlyChanged(item.lastChangedAt, now) ? (
                          <span className="badge-recent">최근변동</span>
                        ) : null}
                        {/* 비고 플래그(design.md D4, spec: "비고 플래그") — 배지는 원문을
                            대체하지 않는 신호일 뿐이다. 원문은 상세 페이지에서 항상 볼 수
                            있다(item detail page). */}
                        {noteFlags.map((flag) => (
                          <span key={flag} className="badge-note">
                            {NOTE_FLAG_LABELS[flag]}
                          </span>
                        ))}
                      </td>
                      <td>{formatText(item.usageType)}</td>
                      <td className="num">{formatWon(item.appraisalPrice)}</td>
                      <td className="num">{formatWon(item.minBidPrice)}</td>
                      <td className="num">
                        {discountRatio === null || discountStage === null ? (
                          EMPTY
                        ) : (
                          // 단계는 텍스트 라벨로 구별된다(색에만 의존하지 않는다, spec: "색에만
                          // 의존해서는 안 된다"). CSS 클래스는 훑어보기를 돕는 보조 수단이다.
                          <span className={`discount-stage discount-stage-${discountStage}`}>
                            {formatDiscountRatio(discountRatio)}{" "}
                            <span className="discount-stage-label">
                              ({DISCOUNT_STAGE_LABELS[discountStage]})
                            </span>
                          </span>
                        )}
                      </td>
                      {/* 면적(㎡·평)과 면적당 가격을 한 칸에 쌓는다(design.md Risks: 새 열을
                          만들지 않는다) — 역전된 면적도 formatAreaRange가 그대로 병기한다
                          (design.md D1). */}
                      <td className="num area-cell">
                        <div>{formatAreaRange(item)}</div>
                        <div className="muted">{formatPricePerArea(pricePerArea)}</div>
                      </td>
                      <td>
                        {formatDate(item.auctionDate)}
                        {dDay.status === "unknown" ? null : (
                          <span className={`badge-dday badge-dday-${dDay.status}`}>
                            {formatDDay(dDay)}
                          </span>
                        )}
                      </td>
                      <td className="num">
                        {formatCount(item.failedBidCount)}
                        {/* 유찰-저감률 불일치(design.md D3) — 어느 쪽이 맞는지 판단하지
                            않고 모순 사실만 알린다. */}
                        {mismatch?.mismatched ? (
                          <span className="badge-mismatch" title={formatMismatchDescription(mismatch)}>
                            불일치
                          </span>
                        ) : null}
                      </td>
                      <td>{formatText(item.status)}</td>
                      <td>
                        {/* item.bookmarked는 listItems가 스칼라 서브쿼리로 채운다
                            (repository.ts design.md D6) — 필터·정렬·total과 무관하다. */}
                        <BookmarkToggleForm
                          itemId={item.id}
                          bookmarked={item.bookmarked ?? false}
                          returnTo={currentListHref}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {items.length === 0 ? (
            <p className="empty">이 페이지에는 물건이 없습니다.</p>
          ) : null}

          {/*
            페이지 링크는 `page`만 바꾸고 나머지 조건은 전부 그대로 들고 간다.
            "다음"을 누르면 필터가 사라지는 것이 이 화면의 대표적인 버그라, URL을 손으로
            조립하지 않고 현재 조건 객체에서 만든다 (`itemListHref`).
          */}
          <nav className="pagination">
            {page > 1 ? (
              <Link href={itemListHref(query, { page: page - 1 })}>← 이전</Link>
            ) : (
              <span className="disabled">← 이전</span>
            )}
            <span className="page-indicator">
              {page} / {totalPages}
            </span>
            {page < totalPages ? (
              <Link href={itemListHref(query, { page: page + 1 })}>다음 →</Link>
            ) : (
              <span className="disabled">다음 →</span>
            )}
          </nav>
        </>
      )}
    </main>
  );
}
