/**
 * `GET /api/items/usage-types` — 저장된 물건에 실제로 존재하는 용도 목록 (design.md D3).
 *
 * 목록 페이지는 서버 컴포넌트라 저장소를 직접 호출하지만, 스펙의 "용도 목록 조회"
 * 요구사항이 외부에서 검증 가능하려면 HTTP 엔드포인트가 있어야 한다.
 *
 * 경로 주의: 형제 디렉터리에 `[id]/route.ts`가 있다. Next.js App Router는 정적 세그먼트를
 * 동적 세그먼트보다 먼저 매칭하므로 `usage-types`가 `[id]`에 잡히지 않는다 — D3가
 * "실제로 확인하라"고 한 부분이며, 구현 후 실제 서버에서 `/api/items/usage-types`와
 * `/api/items/1`이 둘 다 올바른 핸들러로 가는 것을 curl로 확인했다.
 */
import { NextResponse } from "next/server";

import { getRepository } from "@/lib/db";

export const dynamic = "force-dynamic";

export function GET(): NextResponse {
  try {
    // 물건이 없으면 저장소가 빈 배열을 준다 — 오류가 아니다(스펙 "물건이 없을 때").
    return NextResponse.json({ usageTypes: getRepository().listUsageTypes() });
  } catch (error) {
    console.error("[GET /api/items/usage-types] 용도 목록 조회 실패", error);
    return NextResponse.json({ error: "용도 목록 조회에 실패했습니다" }, { status: 500 });
  }
}
