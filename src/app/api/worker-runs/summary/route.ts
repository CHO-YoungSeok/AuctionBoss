/**
 * `GET /api/worker-runs/summary` — 최근 기간 집계(성공률·차단 횟수·누적 변경 건수).
 *
 * 왜 `GET /api/worker-runs`와 분리된 라우트인가: `../route.ts` 상단 주석 참고.
 *
 * 경로 주의: 형제 디렉터리에 `[id]/route.ts`(다른 작업이 추가)가 있다. Next.js App
 * Router는 정적 세그먼트를 동적 세그먼트보다 먼저 매칭하므로 `summary`가 `[id]`에
 * 잡히지 않는다 — 이 프로젝트가 `/api/items/usage-types`(형제 `[id]`)로 이미 실제
 * 서버에서 확인한 패턴과 동일하다.
 */
import { NextResponse } from "next/server";

import { summarizeRuns } from "@/lib/db";

import { parseWorkerRunSummaryQuery } from "../../../_lib/worker-run-query";

export const dynamic = "force-dynamic";

export function GET(request: Request): NextResponse {
  const url = new URL(request.url);

  const parsed = parseWorkerRunSummaryQuery(url.searchParams);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "잘못된 요청 파라미터입니다", details: parsed.issues },
      { status: 400 },
    );
  }

  try {
    const summary = summarizeRuns(parsed.query);
    return NextResponse.json(summary);
  } catch (error) {
    console.error("[GET /api/worker-runs/summary] 회차 집계 조회 실패", error);
    return NextResponse.json({ error: "회차 집계 조회에 실패했습니다" }, { status: 500 });
  }
}
