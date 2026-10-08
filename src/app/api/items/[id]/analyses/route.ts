/**
 * `GET /api/items/[id]/analyses?limit=` — 물건 1건의 분석 이력(switch-web-to-data-port design.md D5).
 *
 * 응답은 `{ analyses, total }`이다. `analyses`는 최신순 최대 `limit`건, `total`은 `limit`과 무관한 전체 건수다.
 * `limit`은 1~50 정수(기본 10). 없는 물건·숫자가 아닌 id는 404다.
 */
import { NextResponse } from "next/server";

import { getRepository } from "@/lib/db";

import { parseAnalysesLimit } from "../../../../_lib/analyses-query";

export const dynamic = "force-dynamic";

const ITEM_ID = /^\d+$/;

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;

  if (!ITEM_ID.test(id)) {
    return NextResponse.json({ error: `물건을 찾을 수 없습니다: id=${id}` }, { status: 404 });
  }

  const parsed = parseAnalysesLimit(new URL(request.url).searchParams);

  try {
    const repository = getRepository();
    const item = repository.getItemById(Number(id));
    if (!item) {
      return NextResponse.json({ error: `물건을 찾을 수 없습니다: id=${id}` }, { status: 404 });
    }
    if (!parsed.success) {
      return NextResponse.json(
        { error: "잘못된 요청 파라미터입니다", details: parsed.issues },
        { status: 400 },
      );
    }
    const analyses = repository.listAnalyses(item.id, { limit: parsed.query.limit });
    const total = repository.countAnalyses(item.id);
    return NextResponse.json({ analyses, total });
  } catch (error) {
    console.error(`[GET /api/items/${id}/analyses] 분석 이력 조회 실패`, error);
    return NextResponse.json({ error: "분석 이력 조회에 실패했습니다" }, { status: 500 });
  }
}
