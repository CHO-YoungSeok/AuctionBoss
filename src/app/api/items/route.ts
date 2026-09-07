/**
 * `GET /api/items` — 물건 목록 조회 API.
 *
 * 분석 워커가 `?analyzed=false&pageSize=N`으로 분석 대상을 받아 가는 계약이므로
 * 응답 형태(`{ items, total, page, pageSize }`)를 임의로 바꾸지 않는다 (design.md D5).
 *
 * 저장소는 방어적으로 값을 clamp하지만, 잘못된 입력을 조용히 보정하면 호출자가
 * 오타를 알아채지 못하므로 API 계층에서 400으로 거절한다.
 */
import { NextResponse } from "next/server";
import { z } from "zod";

import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, getRepository } from "@/lib/db";

export const dynamic = "force-dynamic";

const positiveInt = (label: string) =>
  z
    .string()
    .regex(/^\d+$/, `${label}은(는) 정수여야 합니다`)
    .transform((value) => Number(value));

const querySchema = z.object({
  page: positiveInt("page")
    .refine((value) => value >= 1, "page는 1 이상이어야 합니다")
    .optional(),
  pageSize: positiveInt("pageSize")
    .refine((value) => value >= 1, "pageSize는 1 이상이어야 합니다")
    .refine((value) => value <= MAX_PAGE_SIZE, `pageSize는 ${MAX_PAGE_SIZE} 이하여야 합니다`)
    .optional(),
  analyzed: z
    .enum(["true", "false"], {
      errorMap: () => ({ message: "analyzed는 true 또는 false여야 합니다" }),
    })
    .transform((value) => value === "true")
    .optional(),
});

export function GET(request: Request): NextResponse {
  const url = new URL(request.url);
  const raw = {
    page: url.searchParams.get("page") ?? undefined,
    pageSize: url.searchParams.get("pageSize") ?? undefined,
    analyzed: url.searchParams.get("analyzed") ?? undefined,
  };

  const parsed = querySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "잘못된 요청 파라미터입니다",
        details: parsed.error.issues.map((issue) => ({
          field: issue.path.join(".") || "(root)",
          message: issue.message,
        })),
      },
      { status: 400 },
    );
  }

  const { page = 1, pageSize = DEFAULT_PAGE_SIZE, analyzed } = parsed.data;

  try {
    const result = getRepository().listItems({ page, pageSize, analyzed });
    return NextResponse.json(result);
  } catch (error) {
    console.error("[GET /api/items] 물건 목록 조회 실패", error);
    return NextResponse.json({ error: "물건 목록 조회에 실패했습니다" }, { status: 500 });
  }
}
