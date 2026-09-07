/**
 * `GET /api/items/[id]` — 물건 1건 + 최신 분석 결과.
 *
 * Next.js 15의 라우트 핸들러에서 `params`는 Promise다. `await` 없이 쓰면 빌드가 깨진다.
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
    const analysis = repository.getLatestAnalysis(item.id);
    return NextResponse.json({ item, analysis });
  } catch (error) {
    console.error(`[GET /api/items/${id}] 물건 조회 실패`, error);
    return NextResponse.json({ error: "물건 조회에 실패했습니다" }, { status: 500 });
  }
}
