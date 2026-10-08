/**
 * 관심 물건 목록 페이지(`/bookmarks`, add-bookmarks-and-feed task 4.3).
 *
 * `/`(물건 목록)와 같은 관례를 따른다: 서버 컴포넌트가 데이터 포트(`listBookmarkedItems`)를
 * 호출하고, `force-dynamic`으로 정적 프리렌더를 끈다. 필터·정렬은 없다 — design.md
 * D6이 "관심 물건만 보기" 필터를 목록 쿼리(`/`)에 넣지 않고 전용 페이지로 분리한 이유가
 * 그대로 이 페이지의 존재 이유이므로, 여기에 다시 필터를 얹지 않는다. 페이지네이션만
 * 지원한다.
 */
import Link from "next/link";

import { getDataPort } from "@/lib/data-port";

import { BookmarkToggleForm } from "../_components/bookmark-toggle-form";
import { formatCount, formatDate, formatText, formatWon } from "../_lib/format";

export const dynamic = "force-dynamic";

const BOOKMARKS_PATH = "/bookmarks";

/** `page`만 있는 단순 페이지네이션 링크. 필터가 없으니 `itemListHref` 같은 조건 직렬화가
 * 필요 없다. */
function bookmarksHref(page: number): string {
  return page <= 1 ? BOOKMARKS_PATH : `${BOOKMARKS_PATH}?page=${page}`;
}

/** `?page=` 하나만 lenient하게 읽는다. 잘못된 값(음수, 문자 등)은 1페이지로 복구한다 —
 * `/`가 잘못된 쿼리에 에러 대신 기본값으로 응답하는 것과 같은 원칙(design.md D4). */
function parsePage(raw: string | string[] | undefined): number {
  const value = Array.isArray(raw) ? raw[0] : raw;
  const num = value !== undefined ? Number(value) : NaN;
  return Number.isInteger(num) && num >= 1 ? num : 1;
}

export default async function BookmarksPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const page = parsePage(params.page);

  // 데이터는 맨 위에서 한꺼번에 읽는다(switch-web-to-data-port D4).
  const port = getDataPort();
  const [{ items, total, pageSize }, unreadCount] = await Promise.all([
    port.listBookmarkedItems({ page }),
    port.getUnreadCount(),
  ]);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  // 각 행의 관심 해제 폼이 돌아갈 경로 — 지금 보고 있는 이 관심 목록 페이지 그대로다
  // (design.md D5와 같은 원칙: 물건을 하나 뺐다고 페이지가 초기화되면 안 된다).
  const currentHref = bookmarksHref(page);

  return (
    <main className="page">
      <p className="breadcrumb">
        <Link href="/">← 물건 목록</Link>
        {" · "}
        <Link href="/feed">
          변동 피드{unreadCount > 0 ? ` (미확인 ${unreadCount.toLocaleString("ko-KR")}건)` : ""}
        </Link>
      </p>

      <header className="page-header">
        <h1>관심 물건</h1>
        <p className="muted">{total > 0 ? `${total.toLocaleString("ko-KR")}건` : null}</p>
      </header>

      {total === 0 ? (
        <p className="empty">
          아직 담은 물건이 없습니다. <Link href="/">물건 목록</Link>에서 담아보세요.
        </p>
      ) : (
        <>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>소재지</th>
                  <th>용도</th>
                  <th className="num">감정가</th>
                  <th className="num">최저매각가격</th>
                  <th>매각기일</th>
                  <th className="num">유찰횟수</th>
                  <th>진행상태</th>
                  <th>관심</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.id}>
                    <td>
                      <Link href={`/items/${item.id}`}>{formatText(item.address)}</Link>
                    </td>
                    <td>{formatText(item.usageType)}</td>
                    <td className="num">{formatWon(item.appraisalPrice)}</td>
                    <td className="num">{formatWon(item.minBidPrice)}</td>
                    <td>{formatDate(item.auctionDate)}</td>
                    <td className="num">{formatCount(item.failedBidCount)}</td>
                    <td>{formatText(item.status)}</td>
                    <td>
                      {/* 이 페이지에 나열된 물건은 전부 관심 목록에 있으므로 bookmarked는
                          항상 true다 — 여기서 빼면 이 목록에서 바로 사라진다. */}
                      <BookmarkToggleForm itemId={item.id} bookmarked={true} returnTo={currentHref} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {items.length === 0 ? (
            <p className="empty">이 페이지에는 물건이 없습니다.</p>
          ) : null}

          <nav className="pagination">
            {page > 1 ? (
              <Link href={bookmarksHref(page - 1)}>← 이전</Link>
            ) : (
              <span className="disabled">← 이전</span>
            )}
            <span className="page-indicator">
              {page} / {totalPages}
            </span>
            {page < totalPages ? (
              <Link href={bookmarksHref(page + 1)}>다음 →</Link>
            ) : (
              <span className="disabled">다음 →</span>
            )}
          </nav>
        </>
      )}
    </main>
  );
}
