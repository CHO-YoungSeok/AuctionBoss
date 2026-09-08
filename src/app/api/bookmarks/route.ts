/**
 * `GET /api/bookmarks`(관심 물건 목록)와 `POST /api/bookmarks`(관심 등록)
 * (add-bookmarks-and-feed task 3.1/3.2).
 *
 * ⚠️ **인증이 없다**(design.md D4) — 3회차의 `POST /api/worker-runs`와 같은 판단이다.
 * 현재는 로컬/개인 전용 실행 전제에서만 허용된다. README §7.4/§5에 이미 기록된 경고와
 * 함께 이 change의 쓰기 엔드포인트도 §5에 추가로 기록한다(task 5.3).
 *
 * `GET`(조회)과 `POST`(등록)가 같은 리소스 경로를 쓰는 서로 다른 메서드일 뿐이라 파일을
 * 나누지 않는다(`/api/worker-runs/route.ts`와 같은 관례).
 */
import { NextResponse } from "next/server";
import { z } from "zod";

import { ItemNotFoundError, addBookmark, getRepository, listBookmarkedItems } from "@/lib/db";

import { parsePageQuery } from "../../_lib/feed-query";

export const dynamic = "force-dynamic";

const addBodySchema = z.object({
  itemId: z.number().int("itemId는 정수여야 합니다").positive("itemId는 1 이상이어야 합니다"),
});

function badRequest(message: string, details?: unknown): NextResponse {
  return NextResponse.json({ error: message, details }, { status: 400 });
}

/**
 * `GET /api/bookmarks` — 관심 물건 목록(페이지네이션). 담긴 물건이 없으면 빈 배열(오류
 * 아님, spec: "관심 물건이 없을 때").
 */
export function GET(request: Request): NextResponse {
  const url = new URL(request.url);

  const parsed = parsePageQuery(url.searchParams);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "잘못된 요청 파라미터입니다", details: parsed.issues },
      { status: 400 },
    );
  }

  try {
    const result = listBookmarkedItems(parsed.query);
    return NextResponse.json(result);
  } catch (error) {
    console.error("[GET /api/bookmarks] 관심 물건 목록 조회 실패", error);
    return NextResponse.json({ error: "관심 물건 목록 조회에 실패했습니다" }, { status: 500 });
  }
}

/**
 * `POST /api/bookmarks` — 관심 등록. 중복 등록은 오류 없이 성공으로 처리한다(spec: "중복
 * 등록"). 존재하지 않는 물건은 404이고 아무것도 저장하지 않는다(spec: "존재하지 않는 물건
 * 등록").
 */
export async function POST(request: Request): Promise<NextResponse> {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return badRequest("JSON 본문을 해석할 수 없습니다");
  }

  const parsed = addBodySchema.safeParse(payload);
  if (!parsed.success) {
    return badRequest(
      "잘못된 관심 등록 본문입니다",
      parsed.error.issues.map((issue) => ({
        field: issue.path.join(".") || "(root)",
        message: issue.message,
      })),
    );
  }

  const { itemId } = parsed.data;

  try {
    addBookmark(itemId);
    // bookmarked:true가 채워진 물건을 그대로 돌려준다 — getItemById가 이미 이 값을
    // 채워 주므로(repository.ts design.md D6) 응답에서 다시 계산하지 않는다.
    const item = getRepository().getItemById(itemId);
    return NextResponse.json({ item }, { status: 201 });
  } catch (error) {
    if (error instanceof ItemNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    console.error("[POST /api/bookmarks] 관심 등록 실패", error);
    return NextResponse.json({ error: "관심 등록에 실패했습니다" }, { status: 500 });
  }
}
