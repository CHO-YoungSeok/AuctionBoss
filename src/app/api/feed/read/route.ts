/**
 * `POST /api/feed/read` — 피드 읽음 처리(add-bookmarks-and-feed task 3.3, design.md D3).
 *
 * 사용자의 명시적 동작으로만 호출돼야 한다(spec: "읽음 처리는 사용자의 명시적 동작으로만
 * 일어나야 한다") — `GET /api/feed` 조회는 이 엔드포인트를 호출하지 않는다.
 *
 * 본문이 없어도 된다(현재 시각으로 읽음 처리). `feed_reads`는 행이 하나뿐인 테이블이라
 * (design.md D1) 이 호출은 항상 그 한 행을 갱신한다.
 */
import { NextResponse } from "next/server";

import { getUnreadCount, markFeedRead } from "@/lib/db";

export const dynamic = "force-dynamic";

export function POST(): NextResponse {
  try {
    const now = new Date().toISOString();
    markFeedRead(now);
    return NextResponse.json({ lastReadAt: now, unreadCount: getUnreadCount() });
  } catch (error) {
    console.error("[POST /api/feed/read] 피드 읽음 처리 실패", error);
    return NextResponse.json({ error: "피드 읽음 처리에 실패했습니다" }, { status: 500 });
  }
}
