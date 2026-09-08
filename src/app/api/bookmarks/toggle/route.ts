/**
 * `POST /api/bookmarks/toggle` — 목록·상세 페이지의 관심 토글 폼 전용 엔드포인트
 * (add-bookmarks-and-feed task 4.1/4.2, design.md D5).
 *
 * `POST /api/bookmarks`/`DELETE /api/bookmarks/[itemId]`(순수 JSON API, task 3.1)와 이
 * 라우트를 분리한 이유: 이 프로젝트는 클라이언트 JS를 쓰지 않는다는 규칙이 있어(필터
 * 폼도 `method="get"`이다) 토글 버튼도 평범한 `<form method="post">`여야 한다. HTML
 * 폼은 GET/POST만 낼 수 있고 리다이렉트가 아니라 응답 본문을 그대로 보여주므로, JSON을
 * 돌려주는 REST API에 그대로 폼을 걸면 "관심 등록/해제 후 같은 화면으로 복귀"(spec)를
 * 만족할 수 없다. 그래서 폼 전용 레이어를 하나 더 둔다:
 *
 * - form-urlencoded 본문 `itemId`(대상), `bookmarked`(제출 시점의 현재 상태 — "true"면
 *   해제, 아니면 등록), `returnTo`(복귀할 경로)를 받는다.
 * - 실제 등록/해제는 `addBookmark`/`removeBookmark`(bookmarks.ts)를 그대로 호출한다 —
 *   비즈니스 로직이 두 벌 존재하지 않는다.
 * - 처리 후 `returnTo`로 303 리다이렉트한다. `returnTo`는 반드시 같은 오리진의 상대
 *   경로인지 검증한다(`safe-redirect.ts`) — 오픈 리다이렉트 방지.
 *
 * 정적 세그먼트(`toggle`)가 동적 세그먼트(`[itemId]`)와 형제로 공존하는 것은 이
 * 프로젝트가 이미 쓰는 패턴이다(`/api/items/usage-types` vs `/api/items/[id]`, README §5).
 */
import { NextResponse } from "next/server";

import { ItemNotFoundError, addBookmark, removeBookmark } from "@/lib/db";

import { resolveSafeReturnTo } from "../../../_lib/safe-redirect";

export const dynamic = "force-dynamic";

const ITEM_ID = /^\d+$/;

export async function POST(request: Request): Promise<NextResponse> {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: "폼 본문을 해석할 수 없습니다" }, { status: 400 });
  }

  const itemIdRaw = form.get("itemId");
  const bookmarkedRaw = form.get("bookmarked");
  const returnToRaw = form.get("returnTo");

  if (typeof itemIdRaw !== "string" || !ITEM_ID.test(itemIdRaw)) {
    return NextResponse.json({ error: "itemId가 올바르지 않습니다" }, { status: 400 });
  }
  const itemId = Number(itemIdRaw);
  const currentlyBookmarked = bookmarkedRaw === "true";
  const returnTo = resolveSafeReturnTo(typeof returnToRaw === "string" ? returnToRaw : undefined);

  try {
    if (currentlyBookmarked) {
      removeBookmark(itemId);
    } else {
      addBookmark(itemId);
    }
    return NextResponse.redirect(new URL(returnTo, request.url), 303);
  } catch (error) {
    if (error instanceof ItemNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    console.error("[POST /api/bookmarks/toggle] 관심 토글 실패", error);
    return NextResponse.json({ error: "관심 토글에 실패했습니다" }, { status: 500 });
  }
}
