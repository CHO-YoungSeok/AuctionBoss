/**
 * `GET /api/items/filter-options` — 목록 화면의 필터 선택지(switch-web-to-data-port design.md D5).
 *
 * 용도·시도·시군구·법원 선택지를 한 번에 돌려준다. Spring `/api/items/filter-options`의 계약 원본이다.
 * 정적 경로라 형제 `[id]`에 잡히지 않는다(`usage-types`와 같음).
 */
import { NextResponse } from "next/server";

import { getRepository } from "@/lib/db";

export const dynamic = "force-dynamic";

export function GET(): NextResponse {
  try {
    const repository = getRepository();
    return NextResponse.json({
      usageTypes: repository.listUsageTypes(),
      sidoValues: repository.listSidoValues(),
      sigunguValues: repository.listSigunguValues(),
      courtValues: repository.listCourtValues(),
    });
  } catch (error) {
    console.error("[GET /api/items/filter-options] 필터 선택지 조회 실패", error);
    return NextResponse.json({ error: "필터 선택지 조회에 실패했습니다" }, { status: 500 });
  }
}
