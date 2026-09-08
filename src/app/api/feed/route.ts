/**
 * `GET /api/feed` — 변동 피드 조회(add-bookmarks-and-feed task 3.2, design.md D2/D3).
 *
 * 관심 물건에 생긴 **실제 변경**(`kind = 'change'`, 기준점 제외)을 최신순으로, 미확인
 * 개수와 함께 돌려준다. 조회만으로는 읽음 처리가 되지 않는다(spec: "피드를 열기만 한
 * 경우") — 읽음 처리는 `POST /api/feed/read`(별도 엔드포인트)로만 일어난다.
 *
 * `sinceBookmarkedAt=true`면 각 물건의 관심 등록 시각 이후 변동만 포함한다(design.md D2
 * Open Question — 기본값은 전체 포함이다: 방금 담은 물건의 최근 하락을 못 보면 담은
 * 의미가 없다는 것이 design.md의 명시적 의도).
 */
import { NextResponse } from "next/server";

import { getUnreadCount, listFeed } from "@/lib/db";

import { parseFeedListQuery } from "../../_lib/feed-query";

export const dynamic = "force-dynamic";

export function GET(request: Request): NextResponse {
  const url = new URL(request.url);

  const parsed = parseFeedListQuery(url.searchParams);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "잘못된 요청 파라미터입니다", details: parsed.issues },
      { status: 400 },
    );
  }

  try {
    const result = listFeed(parsed.query);
    const unreadCount = getUnreadCount();
    return NextResponse.json({ ...result, unreadCount });
  } catch (error) {
    console.error("[GET /api/feed] 변동 피드 조회 실패", error);
    return NextResponse.json({ error: "변동 피드 조회에 실패했습니다" }, { status: 500 });
  }
}
