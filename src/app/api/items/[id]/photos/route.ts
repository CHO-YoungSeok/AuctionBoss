/**
 * `GET /api/items/[id]/photos` — 물건 1건의 사진 목록(switch-web-to-data-port design.md D5).
 *
 * 응답은 `{ photos }`(순번 오름차순)이고 서버의 파일 경로(`filePath`)는 넣지 않는다.
 * 사진 파일 자체는 `GET /api/photos/{itemId}/{seq}`가 준다.
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

  if (!ITEM_ID.test(id)) {
    return NextResponse.json({ error: `물건을 찾을 수 없습니다: id=${id}` }, { status: 404 });
  }

  try {
    const repository = getRepository();
    const item = repository.getItemById(Number(id));
    if (!item) {
      return NextResponse.json({ error: `물건을 찾을 수 없습니다: id=${id}` }, { status: 404 });
    }
    const photos = repository.getItemPhotos(item.id).map((photo) => ({
      id: photo.id,
      itemId: photo.itemId,
      seq: photo.seq,
      fileSize: photo.fileSize,
      mimeType: photo.mimeType,
      collectedAt: photo.collectedAt,
    }));
    return NextResponse.json({ photos });
  } catch (error) {
    console.error(`[GET /api/items/${id}/photos] 사진 목록 조회 실패`, error);
    return NextResponse.json({ error: "사진 목록 조회에 실패했습니다" }, { status: 500 });
  }
}
