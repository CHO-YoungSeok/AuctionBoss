/**
 * `GET /api/items` HTTP 경계 테스트.
 *
 * "기존 계약 유지" 시나리오는 지금까지 저장소(`repository.test.ts`) 레벨에서만
 * 고정돼 있었다 — HTTP 경계(라우트 → strict 파서 → 저장소 → 응답 JSON)를 통째로
 * 확인하는 테스트가 없었는데, finding 2의 회귀(`?analyzed=`가 400 대신 200을 반환)가
 * 정확히 이 경계에서 났다. 서버를 띄우지 않고 라우트 핸들러를 직접 import해서 호출한다
 * (`request.ts`의 `GET`은 평범한 함수라 `Request`만 만들어 주면 된다).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { closeDb, getRepository } from "@/lib/db";
import type { AuctionItemInput } from "@/lib/domain";

import { fetchReanalysisCandidates, type FetchFn } from "../../../../../workers/lib/api";
import { GET } from "../route";

const originalEnv = process.env.AUCTIONBOSS_DB;
let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(path.join(tmpdir(), "auctionboss-route-items-"));
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

function request(query: string): Request {
  return new Request(`http://localhost/api/items${query ? `?${query}` : ""}`);
}

describe("GET /api/items", () => {
  it("analyzed=false&pageSize=5는 기존 계약대로 동작한다(analyzer 워커 호출 형태)", async () => {
    const repo = getRepository();
    repo.upsertItems([
      makeItem({ itemNo: "1" }),
      makeItem({ itemNo: "2" }),
      makeItem({ itemNo: "3" }),
    ]);
    repo.insertAnalysis({ itemId: 1, body: "분석 결과", model: null, promptVersion: "v1" });

    const response = GET(request("analyzed=false&pageSize=5"));
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      items: Array<{ id: number }>;
      total: number;
      page: number;
      pageSize: number;
    };
    expect(body.pageSize).toBe(5);
    expect(body.page).toBe(1);
    expect(body.total).toBe(2); // itemNo 2, 3만 미분석
    expect(body.items.map((item) => item.id).sort()).toEqual([2, 3]);
  });

  it("새 필터 파라미터 없이 호출하면 이전과 같은 응답 형태를 돌려준다", async () => {
    const repo = getRepository();
    repo.upsertItems([makeItem()]);

    const response = GET(request(""));
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body).toMatchObject({ page: 1, pageSize: 20, total: 1 });
    expect(Array.isArray(body.items)).toBe(true);
  });

  it("인식할 수 없거나 범위를 벗어난 값은 400과 {error, details:[{field,message}]}를 반환한다", async () => {
    const response = GET(request("sort=nope"));
    expect(response.status).toBe(400);

    const body = (await response.json()) as { error: string; details: unknown };
    expect(typeof body.error).toBe("string");
    expect(body.details).toEqual([
      {
        field: "sort",
        message: expect.stringContaining("sort"),
      },
    ]);
  });

  it("finding 2 — analyzed= 처럼 인식된 파라미터가 빈 값이면 400이다(이전에는 200으로 전체를 반환했다)", async () => {
    const response = GET(request("analyzed="));
    expect(response.status).toBe(400);
    const body = (await response.json()) as { details: Array<{ field: string }> };
    expect(body.details).toEqual([{ field: "analyzed", message: expect.any(String) }]);
  });

  it("finding 2 — sort=, page= 도 같은 이유로 400이다", async () => {
    for (const query of ["sort=", "page="]) {
      const response = GET(request(query));
      expect(response.status, `${query} → 400이어야 한다`).toBe(400);
    }
  });

  it("빈 값이 아닌 정상 파라미터는 여전히 200이다(strict 엄격화가 정상 호출까지 막지 않는다)", async () => {
    const repo = getRepository();
    repo.upsertItems([makeItem()]);

    const response = GET(request("analyzed=false&pageSize=5"));
    expect(response.status).toBe(200);
  });

  /**
   * 코드 리뷰 finding 7b: `needsAnalysis=true`가 `promptVersion` 없이 오면 저장소의
   * 방어적 throw(`buildFilter`)가 그대로 새어 나가 500이 될 위험이 있다 — 이 경계를
   * HTTP 레벨에서 직접 확인한 적이 없었다. 실제로는 `parseItemQuery`(strict 파서)가
   * 이 조합을 미리 400으로 거절하므로 저장소까지 도달하지 않아야 한다.
   */
  it("finding 7 — needsAnalysis=true인데 promptVersion이 없으면 400이다(저장소의 방어적 throw가 500으로 새지 않는다)", async () => {
    const response = GET(request("needsAnalysis=true"));
    expect(response.status).toBe(400);

    const body = (await response.json()) as { details: Array<{ field: string }> };
    expect(body.details.some((detail) => detail.field === "needsAnalysis")).toBe(true);
  });

  /**
   * 코드 리뷰 finding 7b: 분석 워커(`workers/lib/api.ts`)가 재분석 조회에 실제로 만드는
   * URL을 이 라우트가 받아들이는지 확인한다. 손으로 다시 만든 쿼리스트링이 아니라
   * `fetchReanalysisCandidates`가 실제로 조립한 URL을 그대로 쓴다 — 워커와 라우트의
   * 계약이 코드로 어긋나면(예: 파라미터 이름 오타) 여기서 바로 드러난다.
   */
  it("finding 7 — workers/lib/api.ts가 실제로 만드는 재분석 조회 URL을 라우트가 받아들인다", async () => {
    const repo = getRepository();
    repo.upsertItems([makeItem()]);
    const item = repo.listItems({ pageSize: 10 }).items[0]!;
    repo.insertAnalysis({ itemId: item.id, body: "x", model: null, promptVersion: "v0" });

    const builtUrls: string[] = [];
    const captureFetch: FetchFn = async (url) => {
      builtUrls.push(url);
      return new Response(JSON.stringify({ items: [], total: 0, page: 1, pageSize: 5 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    await fetchReanalysisCandidates({
      baseUrl: "http://localhost",
      pageSize: 5,
      promptVersion: "v1",
      fetchFn: captureFetch,
    });
    const builtUrl = builtUrls[0]!;
    expect(builtUrl).toBe("http://localhost/api/items?needsAnalysis=true&promptVersion=v1&pageSize=5");

    // 이제 그 URL을 실제 라우트 핸들러에 그대로 넣는다.
    const response = GET(new Request(builtUrl));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { items: unknown[]; total: number };
    // item의 프롬프트 버전(v0)은 요청 버전(v1)과 다르지만, 방금(테스트 실행 시각) 분석돼
    // 실제 config/collector.json의 reanalysisCooldownHours(24) 안에 있다 — 라우트가
    // needsAnalysis=true일 때 실제 설정을 읽어 쿨다운을 적용한다는 것까지 이 한 번의
    // 호출로 확인된다(finding 3). 그래서 0건이 맞다 — 버전 불일치만으로 대상이
    // 되려면 쿨다운이 먼저 지나야 한다.
    expect(body.items).toEqual([]);
    expect(body.total).toBe(0);
  });
});
