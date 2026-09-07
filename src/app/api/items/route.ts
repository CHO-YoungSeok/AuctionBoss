/**
 * `GET /api/items` — 물건 목록 조회 API.
 *
 * 분석 워커가 `?analyzed=false&pageSize=N`으로 분석 대상을 받아 가는 계약이므로
 * 응답 형태(`{ items, total, page, pageSize }`)를 임의로 바꾸지 않는다 (design.md D5).
 *
 * 파라미터 검증 규칙은 이 파일에 두지 않는다 — `parseItemQuery`(도메인의 strict 파서)
 * 하나만 쓴다. 목록 페이지는 같은 파일의 lenient 파서를 쓰므로 두 진입점의 "무엇이
 * 유효한 값인가"가 갈라지지 않는다 (design.md D4).
 *
 * 저장소는 방어적으로 값을 clamp하지만, 잘못된 입력을 조용히 보정하면 호출자가
 * 오타를 알아채지 못하므로 API 계층에서 400으로 거절한다. (페이지는 반대로 기본값으로
 * 복구한다 — 이 비대칭은 의도적이다.)
 */
import { NextResponse } from "next/server";

import { getRepository } from "@/lib/db";
import { loadCollectorConfig, parseItemQuery } from "@/lib/domain";

export const dynamic = "force-dynamic";

export function GET(request: Request): NextResponse {
  const url = new URL(request.url);

  // 파서의 `issue.field`가 이미 URL 파라미터 이름이라 응답 형태로 그대로 옮긴다.
  const parsed = parseItemQuery(url.searchParams);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "잘못된 요청 파라미터입니다", details: parsed.issues },
      { status: 400 },
    );
  }

  try {
    // 재분석 쿨다운(코드 리뷰 finding 3)은 URL 파라미터가 아니다 — 워커가 조정할 수 있는
    // 값이 아니라 서버 설정(config/collector.json의 analysis.reanalysisCooldownHours)에서만
    // 온다. needsAnalysis=true 요청일 때만 채워 저장소에 넘긴다.
    const query =
      parsed.query.needsAnalysis === true
        ? {
            ...parsed.query,
            reanalysisCooldownHours: loadCollectorConfig().analysis.reanalysisCooldownHours,
          }
        : parsed.query;
    const result = getRepository().listItems(query);
    return NextResponse.json(result);
  } catch (error) {
    console.error("[GET /api/items] 물건 목록 조회 실패", error);
    return NextResponse.json({ error: "물건 목록 조회에 실패했습니다" }, { status: 500 });
  }
}
