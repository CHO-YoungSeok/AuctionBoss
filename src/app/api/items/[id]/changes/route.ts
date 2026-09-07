/**
 * `GET /api/items/[id]/changes` — 물건 1건의 변경 이력(시간순).
 *
 * `auction-history` capability의 "변경 이력 조회" 요구사항:
 * - 이력이 없는 물건은 오류가 아니라 빈 배열.
 * - 존재하지 않는 물건은 404로 거부한다(이력 없음과 물건 없음을 구분).
 *
 * Next.js 15의 라우트 핸들러에서 `params`는 Promise다. `await` 없이 쓰면 빌드가 깨진다
 * (`../[id]/route.ts`와 같은 패턴).
 */
import { NextResponse } from "next/server";

import { getRepository } from "@/lib/db";

export const dynamic = "force-dynamic";

const ITEM_ID = /^\d+$/;

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;

  // 숫자가 아닌 id는 "존재하지 않는 물건"과 사용자 입장에서 같은 상황이라 404로 묶는다.
  if (!ITEM_ID.test(id)) {
    return NextResponse.json({ error: `물건을 찾을 수 없습니다: id=${id}` }, { status: 404 });
  }

  try {
    const repository = getRepository();
    const item = repository.getItemById(Number(id));
    if (!item) {
      return NextResponse.json({ error: `물건을 찾을 수 없습니다: id=${id}` }, { status: 404 });
    }
    const changes = repository.listItemChanges(item.id);
    return NextResponse.json({ changes });
  } catch (error) {
    console.error(`[GET /api/items/${id}/changes] 변경 이력 조회 실패`, error);
    return NextResponse.json({ error: "변경 이력 조회에 실패했습니다" }, { status: 500 });
  }
}
