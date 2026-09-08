/**
 * `DELETE /api/bookmarks/[itemId]` — 관심 해제(add-bookmarks-and-feed task 3.1).
 *
 * `src/app/api/items/[id]/route.ts`와 같은 패턴: 숫자가 아닌 id는 "존재하지 않는 물건"과
 * 사용자 입장에서 같은 상황이라 404로 묶는다. 이미 담기지 않은(하지만 존재하는) 물건을
 * 해제해도 오류가 아니다(idempotent, `removeBookmark`가 보장한다).
 *
 * Next.js 15의 라우트 핸들러에서 `params`는 Promise다.
 */
import { NextResponse } from "next/server";

import { ItemNotFoundError, removeBookmark } from "@/lib/db";

export const dynamic = "force-dynamic";

const ITEM_ID = /^\d+$/;

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ itemId: string }> },
): Promise<NextResponse> {
  const { itemId } = await params;

  if (!ITEM_ID.test(itemId)) {
    return NextResponse.json({ error: `물건을 찾을 수 없습니다: id=${itemId}` }, { status: 404 });
  }

  try {
    removeBookmark(Number(itemId));
    return NextResponse.json({ itemId: Number(itemId), bookmarked: false });
  } catch (error) {
    if (error instanceof ItemNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    console.error(`[DELETE /api/bookmarks/${itemId}] 관심 해제 실패`, error);
    return NextResponse.json({ error: "관심 해제에 실패했습니다" }, { status: 500 });
  }
}
