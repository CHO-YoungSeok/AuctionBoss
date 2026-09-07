/**
 * 재분석 선정 회귀 테스트 (코드 리뷰 finding 2).
 *
 * `analyzer.test.ts`의 재분석 테스트는 전부 `makeTwoPassFetch`로 손수 만든, 서로 겹치지
 * 않는 배열을 fetchFn에 주입해 "신규/재분석 두 조회를 어떻게 합치는가"만 검증한다. 그
 * 방식으로는 실제 SQL 정렬·조건의 버그(재분석 후보 정렬에서 미분석 물건이 NULL로 ASC
 * 맨 앞을 차지해 진짜 재분석 대상을 밀어내는 문제)를 잡을 수 없다 — fetchFn이 이미
 * "정답"을 배열로 들고 있어서, 저장소 SQL이 실제로 무엇을 반환하는지는 전혀 거치지
 * 않기 때문이다. 239개 테스트가 통과하면서도 이 버그가 남아 있었던 이유가 이것이다.
 *
 * 이 테스트는 실제 저장소(임시 파일 DB)와 실제 라우트 핸들러(`GET /api/items`,
 * `POST /api/analyses`)를 fetchFn 뒤에 그대로 연결해 `runAnalysisOnce`의 두 패스 선정을
 * 진짜로 구동한다 — 서버 프로세스는 띄우지 않지만(`route.test.ts`와 같은 패턴), SQL
 * 정렬·조건은 실제로 실행된다.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { closeDb, getRepository } from "@/lib/db";
import type { AuctionItemInput } from "@/lib/domain";

import { POST as analysesPOST } from "../../src/app/api/analyses/route";
import { GET as itemsGET } from "../../src/app/api/items/route";
import { runAnalysisOnce } from "../analyzer";
import type { FetchFn } from "../lib/api";
import { ITEM_JSON_TOKEN, PROMPT_VERSION } from "../lib/prompt";

const TEMPLATE = `분석하라.\n\n\`\`\`json\n${ITEM_JSON_TOKEN}\n\`\`\`\n`;

const originalEnv = process.env.AUCTIONBOSS_DB;
let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(path.join(tmpdir(), "auctionboss-analyzer-integration-"));
  process.env.AUCTIONBOSS_DB = path.join(workDir, "test.db");
});

afterEach(() => {
  closeDb();
  if (originalEnv === undefined) delete process.env.AUCTIONBOSS_DB;
  else process.env.AUCTIONBOSS_DB = originalEnv;
  rmSync(workDir, { recursive: true, force: true });
});

function makeItem(overrides: Partial<AuctionItemInput> = {}): AuctionItemInput {
  return {
    court: "서울중앙지방법원",
    caseNo: "2025타경1",
    itemNo: "1",
    address: "서울특별시 관악구 신림동 1-1",
    usageType: "아파트",
    appraisalPrice: 500_000_000,
    minBidPrice: 400_000_000,
    auctionDate: "2026-10-01",
    failedBidCount: 1,
    status: "진행",
    ...overrides,
  };
}

/** 실제 라우트 핸들러를 호출하는 fetchFn. 네트워크도, 별도 서버 프로세스도 쓰지 않는다. */
const realRouteFetch: FetchFn = async (url, init) => {
  const request = new Request(url, init);
  if (request.method === "POST") return analysesPOST(request);
  return itemsGET(request);
};

describe("runAnalysisOnce — 실제 저장소·라우트로 구동하는 두 패스 선정(finding 2 회귀)", () => {
  it("미분석 물건이 신규 한도보다 많아도, 이미 분석된 뒤 실제로 변경된 물건이 재분석 대상으로 선정된다", async () => {
    const repo = getRepository();

    // 미분석 8건 — 매각기일 내림차순으로 흩어 둔다(정렬 기준이 우연히 유리하게 맞지
    // 않게). 신규 한도(5)보다 많아서 일부는 이번 회차에 처리되지 않는다.
    const unanalyzed: AuctionItemInput[] = Array.from({ length: 8 }, (_, i) =>
      makeItem({ itemNo: `u${i + 1}`, auctionDate: `2026-10-${20 - i}` }),
    );
    repo.upsertItems(unanalyzed, { now: "2026-01-01T00:00:00.000Z" });

    // 재분석 대상 1건 — 분석 완료 후 실제 변경(최저가 하락)이 그 분석 이후에 생겼다.
    // promptVersion을 워커의 현재 버전과 똑같이 둬서, 버전 불일치(조건 2)가 아니라
    // 오직 "실제 변경"(조건 1)만으로 재분석 대상이 되게 한다 — finding 2가 고친 조건이다.
    repo.upsertItems([makeItem({ itemNo: "target", auctionDate: "2026-09-01" })], {
      now: "2026-01-01T00:00:00.000Z",
    });
    const target = repo
      .listItems({ pageSize: 20 })
      .items.find((item) => item.itemNo === "target")!;
    repo.insertAnalysis(
      { itemId: target.id, body: "old", model: null, promptVersion: PROMPT_VERSION },
      { now: "2026-01-02T00:00:00.000Z" },
    );
    repo.upsertItems([makeItem({ itemNo: "target", minBidPrice: 1 })], {
      now: "2026-01-03T00:00:00.000Z",
    });

    const summary = await runAnalysisOnce({
      baseUrl: "http://localhost",
      maxItemsPerRun: 5, // 미분석 8건 중 5건만 신규 한도 — 3건은 이번 회차에서 밀린다
      maxReanalysisPerRun: 2,
      template: TEMPLATE,
      fetchFn: realRouteFetch,
      runClaude: async () => ({ text: "요약", model: null }),
    });

    // target이 실제로 (재)분석돼 두 번째 분석이 저장됐는지 확인한다 — 이전 버그에서는
    // 재분석 후보 정렬(analyzed_at ASC)이 미분석 물건을 NULL로 맨 앞에 두고, 워커의
    // dedupe는 신규 패스가 이미 뽑은 물건만 제거하므로, 신규 패스에 뽑히지 않은
    // 미분석 물건(u1~u3)이 재분석 페이지(pageSize=2)를 채워 target이 영원히 조회되지
    // 않았다.
    const analyses = repo.listAnalyses(target.id);
    expect(analyses).toHaveLength(2);
    expect(analyses.map((a) => a.body)).toContain("요약");
    expect(summary.failed).toBe(0);
  });

  it("미분석 물건만 있고 재분석 대상이 없으면(finding 2 수정 후 회귀 방어) 재분석 조회는 0건을 반환한다", async () => {
    const repo = getRepository();
    repo.upsertItems(
      Array.from({ length: 3 }, (_, i) => makeItem({ itemNo: `u${i + 1}` })),
      { now: "2026-01-01T00:00:00.000Z" },
    );

    const summary = await runAnalysisOnce({
      baseUrl: "http://localhost",
      maxItemsPerRun: 10,
      maxReanalysisPerRun: 5,
      template: TEMPLATE,
      fetchFn: realRouteFetch,
      runClaude: async () => ({ text: "요약", model: null }),
    });

    // 신규 3건만 분석되고, 미분석 물건이 재분석 패스에 섞여 다시 처리되지 않는다.
    expect(summary).toEqual({ attempted: 3, succeeded: 3, failed: 0 });
  });
});
