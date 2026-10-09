/**
 * 확장 필드가 API 라운드트립을 거쳐 프롬프트에 실제로 도달하는지 보는 회귀 테스트
 * (live-data-and-reports 실측 task 3.1/3.4·6.4, migrate-data-and-cutover 8.2).
 *
 * 실제 수집 데이터로 analyzer를 돌려 생성된 보고서를 읽어 보니 `minArea`·`minBidPriceRound1`·`note`("일괄매각")
 * 등이 `GET /api/items` 응답에는 있는데도 모든 분석이 "면적 또는 최저매각가격 정보 없음"이라고 답했다 —
 * `workers/lib/api.ts`의 zod 스키마가 확장 필드 32개를 몰라 조용히 strip하고 있었다. `derived.test.ts`/
 * `analyzer.test.ts`는 손수 만든 `AuctionItem`을 프롬프트에 직접 넣어서만 검증해 이 경로
 * (응답 JSON → zod 파싱 → 프롬프트)를 통과하지 못했다.
 *
 * 이전에는 Next 라우트 핸들러와 SQLite를 뒤에 붙였다. 그 둘이 은퇴해 이제 응답은 **동결된 계약 골든**
 * (`backend/src/test/resources/contracts/scenarios/analyses.json`의 `GET /api/items` 응답 — Spring이 실제로 내는 모양)을
 * 그대로 돌려주는 대역 `fetch`다. 재분석 선정 SQL(정렬·조건)은 백엔드(Java `ItemSearchRepositoryTest`의
 * `needsAnalysis*`)가 증명하고, 워커의 두 패스 합산은 `analyzer.test.ts`가 본다.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { runAnalysisOnce } from "../analyzer";
import type { FetchFn } from "../lib/api";
import { DERIVED_FIGURES_TOKEN, ITEM_JSON_TOKEN } from "../lib/prompt";

const TEMPLATE_WITH_DERIVED = `분석하라.\n\n${DERIVED_FIGURES_TOKEN}\n\n\`\`\`json\n${ITEM_JSON_TOKEN}\n\`\`\`\n`;

const GOLDEN = path.resolve(__dirname, "../../backend/src/test/resources/contracts/scenarios/analyses.json");

interface GoldenStep {
  request: { method?: string; path: string; query?: string };
  status: number;
  body: unknown;
}

/** 골든에서 `GET /api/items` 응답(물건 1건: 확장 필드가 채워진 실데이터 모양)을 꺼낸다. */
function goldenItemsBody(): { items: Record<string, unknown>[]; total: number; page: number; pageSize: number } {
  const golden = JSON.parse(readFileSync(GOLDEN, "utf8")) as { steps: GoldenStep[] };
  const step = golden.steps.find((s) => s.request.path === "/api/items" && s.status === 200)!;
  return step.body as never;
}

describe("runAnalysisOnce — 확장 필드가 API 라운드트립을 거쳐 프롬프트에 실제로 도달한다 (실데이터 회귀)", () => {
  it("minArea·minBidPriceRound1·note가 GET /api/items 응답(골든)에서 프롬프트까지 살아 있다", async () => {
    const body = goldenItemsBody();
    const item = body.items[0]!;
    // 골든 물건은 확장 필드가 실제로 채워져 있다(이 전제가 깨지면 아래 단언이 무의미하다).
    expect(item.minArea).toBe(858);
    expect(item.minBidPriceRound1).toBe(26_114_690_622);
    expect(item.note).toBe("일괄매각. 제시외 건물 포함");

    const requests: string[] = [];
    const fetchFn: FetchFn = async (url, init) => {
      const request = new Request(url, init);
      requests.push(`${request.method} ${new URL(request.url).pathname}`);
      const pathname = new URL(request.url).pathname;
      if (request.method === "POST" && pathname === "/api/worker-runs") return Response.json({ id: 1 }, { status: 201 });
      if (request.method === "PATCH") return Response.json({ id: 1 });
      if (request.method === "POST") return Response.json({ analysis: { id: 1 } }, { status: 201 });
      // 신규 조회(analyzed=false)에는 이 물건 1건, 재분석 조회(needsAnalysis=true)에는 없음.
      return Response.json(
        new URL(request.url).searchParams.has("needsAnalysis") ? { ...body, items: [], total: 0 } : body,
      );
    };

    let capturedPrompt = "";
    const summary = await runAnalysisOnce({
      baseUrl: "http://localhost",
      maxItemsPerRun: 1,
      maxReanalysisPerRun: 0,
      template: TEMPLATE_WITH_DERIVED,
      fetchFn,
      runClaude: async ({ prompt }) => {
        capturedPrompt = prompt;
        return { text: "요약", model: null };
      },
    });

    expect(summary).toEqual({ attempted: 1, succeeded: 1, failed: 0 });
    expect(requests).toContain("POST /api/analyses");
    // derived.ts가 코드로 계산한 값이 프롬프트에 숫자로 박혀 있어야 한다 — "계산 불가"가 아니다.
    // 이 값이 나오려면 fetchUnanalyzedItems가 돌려준 item에 minArea·minBidPriceRound1이 실제로 있어야 하므로,
    // zod 스키마가 그 필드들을 strip하면 이 단언이 실패한다(수정 전 실제로 실패했다).
    expect(capturedPrompt).toContain("면적당 최저매각가격: 30,436,702원/㎡");
    expect(capturedPrompt).toContain("1차: 26,114,690,622원 (감정가 대비 51.2%)");
    expect(capturedPrompt).not.toContain("면적 또는 최저매각가격 정보 없음");
    expect(capturedPrompt).not.toContain("차수별 최저가 정보 없음");
    // 물건 JSON 블록에도 note가 원문 그대로 있어야 한다(같은 zod 스키마가 담당).
    expect(capturedPrompt).toContain('"note": "일괄매각. 제시외 건물 포함"');
  });
});
