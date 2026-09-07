/**
 * `POST /api/analyses` — 분석 결과 수신 API.
 *
 * 분석 워커는 DB를 직접 쓰지 않고 이 API로만 결과를 저장한다 (design.md D5).
 * 존재하지 않는 물건에 대한 결과는 저장하지 않고 404로 거절해야 한다.
 */
import { NextResponse } from "next/server";
import { z } from "zod";

import { ItemNotFoundError, getRepository } from "@/lib/db";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  itemId: z.number().int("itemId는 정수여야 합니다").positive("itemId는 1 이상이어야 합니다"),
  body: z.string().min(1, "body는 비어 있을 수 없습니다"),
  promptVersion: z.string().min(1, "promptVersion은 비어 있을 수 없습니다"),
  model: z.string().min(1, "model은 비어 있을 수 없습니다").optional(),
});

function badRequest(message: string, details?: unknown): NextResponse {
  return NextResponse.json({ error: message, details }, { status: 400 });
}

export async function POST(request: Request): Promise<NextResponse> {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return badRequest("JSON 본문을 해석할 수 없습니다");
  }

  const parsed = bodySchema.safeParse(payload);
  if (!parsed.success) {
    return badRequest(
      "잘못된 분석 결과 본문입니다",
      parsed.error.issues.map((issue) => ({
        field: issue.path.join(".") || "(root)",
        message: issue.message,
      })),
    );
  }

  const { itemId, body, promptVersion, model } = parsed.data;

  try {
    const analysis = getRepository().insertAnalysis({
      itemId,
      body,
      promptVersion,
      // 도메인 모델은 "값 없음"을 null로 표현한다. optional을 그대로 넘기지 않는다.
      model: model ?? null,
    });
    return NextResponse.json(analysis, { status: 201 });
  } catch (error) {
    if (error instanceof ItemNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    // 예상 못한 오류를 성공으로 위장하지 않는다. 로그를 남기고 500으로 알린다.
    console.error("[POST /api/analyses] 분석 결과 저장 실패", error);
    return NextResponse.json({ error: "분석 결과 저장에 실패했습니다" }, { status: 500 });
  }
}
