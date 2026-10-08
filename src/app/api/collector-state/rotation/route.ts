/**
 * `GET /api/collector-state/rotation` — 수집기가 다음 회차에 처리할 법원 코드(switch-web-to-data-port design.md D5).
 *
 * 응답은 `{ nextCourtCode }`(기록 없으면 null)다. 차단 백오프 같은 다른 수집기 상태는 노출하지 않는다.
 */
import { NextResponse } from "next/server";

import { COLLECTOR_STATE_KEYS, getCollectorState } from "@/lib/db";

export const dynamic = "force-dynamic";

export function GET(): NextResponse {
  try {
    const nextCourtCode = getCollectorState(COLLECTOR_STATE_KEYS.ROTATION_NEXT_COURT_CODE);
    return NextResponse.json({ nextCourtCode });
  } catch (error) {
    console.error("[GET /api/collector-state/rotation] 로테이션 위치 조회 실패", error);
    return NextResponse.json({ error: "로테이션 위치 조회에 실패했습니다" }, { status: 500 });
  }
}
