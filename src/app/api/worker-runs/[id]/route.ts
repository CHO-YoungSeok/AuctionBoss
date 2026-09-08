/**
 * `PATCH /api/worker-runs/[id]` — 회차 종료 기록 (add-collection-observability, design.md D3).
 *
 * `finishRun` 저장소 함수를 그대로 호출하는 얇은 층이다 — `POST /api/worker-runs`와 같은
 * 이유로, collector(저장소 직접 호출)와 analyzer(이 API) 두 경로의 기록 규칙이 갈라지지
 * 않게 한다.
 *
 * Next.js 15의 라우트 핸들러에서 `params`는 Promise다.
 */
import { NextResponse } from "next/server";
import { z } from "zod";

import { WorkerRunNotFoundError, finishRun } from "@/lib/db";
import type { AnalyzerRunDetail, CollectorRunDetail } from "@/lib/domain";

export const dynamic = "force-dynamic";

const RUN_ID = /^\d+$/;

// zod 스키마와 도메인 타입이 어긋나면 컴파일 시점에 잡는다(workers/lib/api.ts와 같은 방식).
type Assert<T extends true> = T;

const collectorDetailSchema = z.object({
  targetCourts: z.array(z.string()),
  pagesRequested: z.number(),
  itemsFetched: z.number(),
  inserted: z.number(),
  updated: z.number(),
  changed: z.number(),
});
export type CollectorDetailSchemaMatchesType = Assert<
  z.infer<typeof collectorDetailSchema> extends CollectorRunDetail ? true : false
>;
export type CollectorDetailTypeMatchesSchema = Assert<
  CollectorRunDetail extends z.infer<typeof collectorDetailSchema> ? true : false
>;

const analyzerDetailSchema = z.object({
  newCount: z.number(),
  reanalysisCount: z.number(),
  succeeded: z.number(),
  failed: z.number(),
});
export type AnalyzerDetailSchemaMatchesType = Assert<
  z.infer<typeof analyzerDetailSchema> extends AnalyzerRunDetail ? true : false
>;
export type AnalyzerDetailTypeMatchesSchema = Assert<
  AnalyzerRunDetail extends z.infer<typeof analyzerDetailSchema> ? true : false
>;

const finishBodySchema = z.object({
  outcome: z.enum(["success", "failed", "blocked"]),
  errorKind: z.string().min(1).optional().nullable(),
  errorMessage: z.string().min(1).optional().nullable(),
  detail: z.union([collectorDetailSchema, analyzerDetailSchema]).optional().nullable(),
});

function badRequest(message: string, details?: unknown): NextResponse {
  return NextResponse.json({ error: message, details }, { status: 400 });
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;

  // 숫자가 아닌 id는 "존재하지 않는 회차"와 사용자 입장에서 같은 상황이라 404로 묶는다
  // (src/app/api/items/[id]/route.ts와 같은 관례).
  if (!RUN_ID.test(id)) {
    return NextResponse.json({ error: `회차를 찾을 수 없습니다: id=${id}` }, { status: 404 });
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return badRequest("JSON 본문을 해석할 수 없습니다");
  }

  const parsed = finishBodySchema.safeParse(payload);
  if (!parsed.success) {
    return badRequest(
      "잘못된 회차 종료 본문입니다",
      parsed.error.issues.map((issue) => ({
        field: issue.path.join(".") || "(root)",
        message: issue.message,
      })),
    );
  }

  const { outcome, errorKind, errorMessage, detail } = parsed.data;

  try {
    const run = finishRun(Number(id), {
      outcome,
      errorKind: errorKind ?? null,
      errorMessage: errorMessage ?? null,
      detail: detail ?? null,
    });
    return NextResponse.json(run);
  } catch (error) {
    if (error instanceof WorkerRunNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    console.error(`[PATCH /api/worker-runs/${id}] 회차 종료 기록 실패`, error);
    return NextResponse.json({ error: "회차 종료 기록에 실패했습니다" }, { status: 500 });
  }
}
