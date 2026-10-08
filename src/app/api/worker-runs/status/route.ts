/**
 * `GET /api/worker-runs/status?worker=` — 워커 상태 판정(switch-web-to-data-port design.md D5).
 *
 * 응답은 `{ state, lastSuccessAt, lastRun }`이다. 판정 규칙은 `getWorkerStatus`(기대 주기 ×
 * `staleAfterIntervals`)이고 "지금"은 서버 시각이다. `worker`는 필수다.
 *
 * 경로 주의: 형제 `[id]`(PATCH)와 겹치지 않는다. 정적 세그먼트가 먼저 매칭된다(`summary`와 같음).
 */
import { NextResponse } from "next/server";
import { z } from "zod";

import { getWorkerStatus } from "@/lib/db";
import { WORKER_KINDS } from "@/lib/domain";

export const dynamic = "force-dynamic";

const workerSchema = z.enum(WORKER_KINDS, {
  errorMap: () => ({ message: `worker는 ${WORKER_KINDS.join(", ")} 중 하나여야 합니다` }),
});

export function GET(request: Request): NextResponse {
  const params = new URL(request.url).searchParams;
  const raw = params.has("worker") ? params.get("worker")?.trim() : undefined;
  const parsed = workerSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "잘못된 요청 파라미터입니다",
        details: [
          {
            field: "worker",
            message: raw === undefined ? "worker는 필수입니다" : parsed.error.issues[0].message,
          },
        ],
      },
      { status: 400 },
    );
  }

  try {
    return NextResponse.json(getWorkerStatus(parsed.data));
  } catch (error) {
    console.error("[GET /api/worker-runs/status] 워커 상태 조회 실패", error);
    return NextResponse.json({ error: "워커 상태 조회에 실패했습니다" }, { status: 500 });
  }
}
