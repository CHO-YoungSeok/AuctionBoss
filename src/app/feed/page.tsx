/**
 * 변동 피드 페이지(`/feed`, add-bookmarks-and-feed task 4.4).
 *
 * `/`(물건 목록)와 같은 관례: 서버 컴포넌트가 데이터 포트(`listFeed`/`getUnreadCount`)를
 * 호출하고 `force-dynamic`으로 정적 프리렌더를 끈다.
 *
 * ⚠️ 이 페이지를 여는 것 자체는 읽음 처리를 하지 않는다(design.md D3, spec: "피드를 열기만
 * 한 경우"). `listFeed`/`getUnreadCount`는 순수 조회이고, 읽음 처리는 아래 "전체 읽음
 * 처리" 폼이 `/api/feed/mark-read`를 호출해야만 일어난다.
 *
 * 미확인 판정(`isFeedEntryUnread`)과 변동 요약 문구(`formatFeedEntryDisplay`)는 전부
 * `../_lib/feed-display.ts`의 순수 함수에서 계산된 결과를 그대로 쓴다(task 4.6) — 이
 * 페이지는 그 결과를 그리기만 한다.
 */
import Link from "next/link";

import { getDataPort } from "@/lib/data-port";

import { formatFeedEntryDisplay, isFeedEntryUnread } from "../_lib/feed-display";
import { formatDateTime } from "../_lib/format";

export const dynamic = "force-dynamic";

const FEED_PATH = "/feed";

/** `page`만 있는 단순 페이지네이션 링크. `/bookmarks`와 같은 이유로 조건 직렬화가 따로
 * 필요 없다. */
function feedHref(page: number): string {
  return page <= 1 ? FEED_PATH : `${FEED_PATH}?page=${page}`;
}

/** `?page=` 하나만 lenient하게 읽는다. `/bookmarks`의 `parsePage`와 같은 규칙. */
function parsePage(raw: string | string[] | undefined): number {
  const value = Array.isArray(raw) ? raw[0] : raw;
  const num = value !== undefined ? Number(value) : NaN;
  return Number.isInteger(num) && num >= 1 ? num : 1;
}

export default async function FeedPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const page = parsePage(params.page);

  // listFeed는 조회만 한다 — 이 호출로는 읽음 처리가 절대 일어나지 않는다(design.md D3).
  const port = getDataPort();
  const [{ entries, total, pageSize }, unreadCount] = await Promise.all([
    port.listFeed({ page }),
    port.getUnreadCount(),
  ]);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  // "전체 읽음 처리" 폼이 돌아갈 경로 — 지금 보고 있는 이 피드 페이지 그대로다(design.md
  // D5와 같은 원칙).
  const currentHref = feedHref(page);

  return (
    <main className="page">
      <p className="breadcrumb">
        <Link href="/">← 물건 목록</Link>
        {" · "}
        <Link href="/bookmarks">관심 물건</Link>
      </p>

      <header className="page-header">
        <h1>변동 피드</h1>
        <p className="muted">
          {total > 0
            ? `전체 ${total.toLocaleString("ko-KR")}건 · 미확인 ${unreadCount.toLocaleString("ko-KR")}건`
            : null}
        </p>
      </header>

      {/* 읽음 처리는 사용자의 명시적 동작으로만 일어나야 한다(spec: "미확인 변동
          구별") — 미확인이 없을 때는 이 버튼 자체를 보여주지 않는다. */}
      {unreadCount > 0 ? (
        <form method="post" action="/api/feed/mark-read" className="mark-read-form">
          <input type="hidden" name="returnTo" value={currentHref} />
          <button type="submit">전체 읽음 처리 (미확인 {unreadCount.toLocaleString("ko-KR")}건)</button>
        </form>
      ) : null}

      {total === 0 ? (
        <p className="empty">아직 변동이 없습니다.</p>
      ) : (
        <>
          <ul className="feed-list">
            {entries.map((entry, indexOnPage) => {
              const display = formatFeedEntryDisplay(entry);
              const unread = isFeedEntryUnread({ page, pageSize, indexOnPage, unreadCount });
              return (
                <li key={display.id} className={unread ? "feed-row feed-row-unread" : "feed-row"}>
                  {unread ? <span className="badge-unread">미확인</span> : null}
                  <span className="feed-time">{formatDateTime(display.changedAt)}</span>
                  <Link href={`/items/${display.itemId}`} className="feed-item-link">
                    {display.itemAddress}
                  </Link>
                  <span className="feed-field">{display.label}</span>
                  <span
                    className={
                      display.direction ? `change-value change-${display.direction}` : "change-value"
                    }
                  >
                    {display.text}
                  </span>
                </li>
              );
            })}
          </ul>

          {entries.length === 0 ? <p className="empty">이 페이지에는 변동이 없습니다.</p> : null}

          <nav className="pagination">
            {page > 1 ? (
              <Link href={feedHref(page - 1)}>← 이전</Link>
            ) : (
              <span className="disabled">← 이전</span>
            )}
            <span className="page-indicator">
              {page} / {totalPages}
            </span>
            {page < totalPages ? (
              <Link href={feedHref(page + 1)}>다음 →</Link>
            ) : (
              <span className="disabled">다음 →</span>
            )}
          </nav>
        </>
      )}
    </main>
  );
}
