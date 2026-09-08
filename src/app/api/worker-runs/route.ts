/**
 * `POST /api/worker-runs` — 회차 시작 기록 (add-collection-observability, design.md D3).
 *
 * 분석 워커는 DB를 직접 열지 않고 HTTP로만 통신한다(기존 D5 결정). 이 라우트는
 * `startRun` 저장소 함수를 그대로 호출하는 **얇은 층**이다 — collector(저장소 직접 호출)와
 * analyzer(이 API) 두 기록 경로가 로직으로 갈라지지 않게 한다.
 *
 * ⚠️ 인증이 없다(design.md D3) — 현재 로컬/개인 전용 실행 전제다. 외부에 노출되면
 * 임의의 회차 기록을 주입할 수 있다.
 *
 * `GET`(회차 기록 조회, task 5.1)은 이 파일 아래쪽에 같이 있다 — POST(기록)와 GET(조회)가
 * 같은 리소스 경로를 쓰는 서로 다른 메서드일 뿐이라 파일을 나눌 이유가 없다.
 */
import { NextResponse } from "next/server";
import { z } from "zod";

import { listWorkerRuns, startRun } from "@/lib/db";
import { WORKER_KINDS } from "@/lib/domain";

import { parseWorkerRunListQuery } from "../../_lib/worker-run-query";

export const dynamic = "force-dynamic";

const startBodySchema = z.object({
  worker: z.enum(WORKER_KINDS),
});

function badRequest(message: string, details?: unknown): NextResponse {
  return NextResponse.json({ error: message, details }, { status: 400 });
}

/**
 * `GET /api/worker-runs` — 회차 기록 조회(design.md D1/D5, 스펙 "회차 기록 조회").
 *
 * 워커 종류(`worker`)와 결과 구분(`outcome`)으로 필터링하고, 페이지네이션 정보와 함께
 * 최신순 목록을 돌려준다. 응답 형태(`{ runs, total, page, pageSize }`)는 저장소의
 * `listWorkerRuns` 반환 형태를 그대로 노출한다(`/api/items`와 같은 관례).
 *
 * 집계(성공률·차단 횟수·누적 변경 건수)는 이 라우트가 맡지 않고 `GET
 * /api/worker-runs/summary`가 별도로 맡는다(task 5.1 선택지 중 "별도 라우트"를 택함).
 * 이유:
 * - 목록과 집계는 응답 형태가 근본적으로 다르다(목록: 배열 + 페이지네이션, 집계: 단일
 *   요약 객체). 플래그 하나로 같은 라우트 안에서 두 형태를 오가게 하면 응답 타입이
 *   쿼리 파라미터에 따라 갈라져 클라이언트가 매번 분기해야 한다.
 * - 파라미터 집합도 다르다(목록: outcome/page/pageSize, 집계: since). 한 스키마에
 *   합치면 "이 조합이 유효한가"를 항상 신경 써야 한다.
 * - 이 프로젝트가 정적 세그먼트를 동적 세그먼트 옆에 두는 패턴을 이미 검증했다
 *   (`/api/items/usage-types`가 `/api/items/[id]`와 형제). `/api/worker-runs/summary`도
 *   이 change에서 함께 추가되는 `/api/worker-runs/[id]`와 형제로 두는 데 같은 근거가
 *   그대로 적용된다.
 */
export function GET(request: Request): NextResponse {
  const url = new URL(request.url);

  const parsed = parseWorkerRunListQuery(url.searchParams);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "잘못된 요청 파라미터입니다", details: parsed.issues },
      { status: 400 },
    );
  }

  try {
    const result = listWorkerRuns(parsed.query);
    return NextResponse.json(result);
  } catch (error) {
    console.error("[GET /api/worker-runs] 회차 기록 조회 실패", error);
    return NextResponse.json({ error: "회차 기록 조회에 실패했습니다" }, { status: 500 });
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return badRequest("JSON 본문을 해석할 수 없습니다");
  }

  const parsed = startBodySchema.safeParse(payload);
  if (!parsed.success) {
    return badRequest(
      "잘못된 회차 시작 본문입니다",
      parsed.error.issues.map((issue) => ({
        field: issue.path.join(".") || "(root)",
        message: issue.message,
      })),
    );
  }

  try {
    const id = startRun(parsed.data.worker);
    return NextResponse.json({ id }, { status: 201 });
  } catch (error) {
    console.error("[POST /api/worker-runs] 회차 시작 기록 실패", error);
    return NextResponse.json({ error: "회차 시작 기록에 실패했습니다" }, { status: 500 });
  }
}
