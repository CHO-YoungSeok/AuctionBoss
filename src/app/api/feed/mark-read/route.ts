/**
 * `POST /api/feed/mark-read` — `/feed` 화면의 "읽음 처리" 버튼 전용 엔드포인트
 * (add-bookmarks-and-feed task 4.4, design.md D3/D5).
 *
 * `POST /api/feed/read`(순수 JSON API, task 3.3)와 이 라우트를 분리한 이유는
 * `/api/bookmarks/toggle`(`toggle/route.ts` 상단 주석)과 같다: 이 프로젝트는 클라이언트
 * JS를 쓰지 않으므로 화면의 버튼도 평범한 `<form method="post">`여야 하고, HTML 폼은
 * JSON 응답이 아니라 리다이렉트를 필요로 한다.
 *
 * form-urlencoded 본문 `returnTo`(복귀할 경로)만 받는다 — 읽음 처리는 대상을 지정하지
 * 않고 피드 전체를 한 번에 처리한다(`markFeedRead`가 이미 그렇게 동작한다). 실제 처리는
 * `markFeedRead`를 그대로 호출해 로직을 두 벌로 만들지 않는다.
 *
 * ⚠️ 이 라우트가 호출될 때만 읽음 처리가 일어난다 — `GET /api/feed`나 `/feed` 페이지를
 * 여는 것만으로는 절대 호출되지 않는다(spec: "피드를 열기만 한 경우").
 */
import { NextResponse } from "next/server";

import { markFeedRead } from "@/lib/db";

import { resolveSafeReturnTo } from "../../../_lib/safe-redirect";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<NextResponse> {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: "폼 본문을 해석할 수 없습니다" }, { status: 400 });
  }

  const returnToRaw = form.get("returnTo");
  const returnTo = resolveSafeReturnTo(typeof returnToRaw === "string" ? returnToRaw : undefined);

  try {
    markFeedRead(new Date().toISOString());
    return NextResponse.redirect(new URL(returnTo, request.url), 303);
  } catch (error) {
    console.error("[POST /api/feed/mark-read] 읽음 처리 실패", error);
    return NextResponse.json({ error: "읽음 처리에 실패했습니다" }, { status: 500 });
  }
}
