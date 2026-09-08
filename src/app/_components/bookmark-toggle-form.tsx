/**
 * 관심 토글 폼(목록 행·상세 페이지 공용, add-bookmarks-and-feed task 4.1/4.2, design.md D5).
 *
 * 클라이언트 JS 없이 `<form method="post" action="/api/bookmarks/toggle">`로 제출한다
 * (`ItemFilterForm`과 같은 프로젝트 규칙 — 토글 하나 때문에 규칙을 깨지 않는다).
 *
 * `returnTo`(제출 후 돌아갈 경로)는 hidden input으로 실어 보낸다 — 목록 행에서는 현재
 * 필터·정렬·페이지가 실린 URL(`itemListHref(query)`), 상세 페이지에서는 그 물건의 상세
 * 경로(`/items/{id}`)를 그대로 넘긴다. 실제 검증(오픈 리다이렉트 방지)은 서버
 * (`/api/bookmarks/toggle` → `safe-redirect.ts`)가 하므로 여기서는 현재 경로 문자열만
 * 그대로 실어 보내면 된다.
 *
 * `bookmarked`(제출 시점의 현재 상태)도 hidden input으로 같이 보낸다 — 서버가 그 값을
 * 보고 등록/해제를 결정한다(`toggle/route.ts`).
 */
export function BookmarkToggleForm({
  itemId,
  bookmarked,
  returnTo,
  className,
}: {
  itemId: number;
  bookmarked: boolean;
  returnTo: string;
  className?: string;
}) {
  return (
    <form method="post" action="/api/bookmarks/toggle" className={className}>
      <input type="hidden" name="itemId" value={itemId} />
      <input type="hidden" name="bookmarked" value={String(bookmarked)} />
      <input type="hidden" name="returnTo" value={returnTo} />
      <button
        type="submit"
        className={bookmarked ? "bookmark-btn bookmark-btn-active" : "bookmark-btn"}
        aria-pressed={bookmarked}
      >
        {bookmarked ? "★ 관심 해제" : "☆ 관심 등록"}
      </button>
    </form>
  );
}
