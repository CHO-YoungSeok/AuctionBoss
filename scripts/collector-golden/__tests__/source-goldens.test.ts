import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { SOURCE_CONTRACTS_DIR } from "../extract-fixtures";
import { generateSourceGoldens, type Outcome } from "../generate-source-goldens";
import { loopbackOnlyFetch, withLoopbackServer } from "../loopback";
import { buildSourceCases } from "../source-cases";

type Summary = string;

/** 결과를 "물건 수/요청 수" 또는 "오류 종류/요청 수"로 줄여 쓴다. */
function summarize(o: Outcome): Summary {
  if ("items" in o) return `items:${o.items.length}/pages:${o.pagesRequested}`;
  if ("photos" in o) return `photos:${o.photos.length}/requests:${o.requestsMade}`;
  return `${o.error.kind}/requests:${o.error.requestsMade}`;
}

/**
 * 기존 어댑터 단위 테스트(`src/lib/sources/courtauction/__tests__/adapter.test.ts`)가 같은 입력에서
 * 확인하는 결과(물건 수, 요청 수, 오류 종류)와 같아야 한다.
 */
const EXPECTED: Record<string, Summary[]> = {
  "search-single-page": ["items:3/pages:1"],
  "search-three-pages": ["items:3/pages:3"],
  "search-empty-page-early-stop": ["items:2/pages:2"],
  "search-max-pages-cap": ["items:2/pages:2"],
  "search-page-size-clamp": ["items:1/pages:1"],
  "search-bundle-fold": ["items:1/pages:1"],
  "search-road-only": ["items:1/pages:1"],
  "search-no-extended-fields": ["items:2/pages:1"],
  "search-missing-key-row-dropped": ["items:1/pages:1"],
  "search-raw-codes-preserved": ["items:1/pages:1"],
  "search-two-courts": ["items:2/pages:2"],
  "search-no-session-cookie": ["items:1/pages:1"],
  "court-code-from-name": ["items:1/pages:1"],
  "court-unknown-name": ["SourceRequestError/requests:0"],
  "block-waf-html": ["WafBlockedError/requests:1"],
  "block-ipcheck-false-with-message": ["RobotDetectedError/requests:1"],
  "block-ipcheck-false-no-message": ["RobotDetectedError/requests:1"],
  "block-on-page-2": ["RobotDetectedError/requests:2"],
  "block-on-second-court": ["RobotDetectedError/requests:2"],
  "schema-data-missing": ["ResponseSchemaError/requests:1"],
  "schema-violation": ["ResponseSchemaError/requests:1"],
  "schema-page-info-missing": ["ResponseSchemaError/requests:1"],
  "schema-json-unparseable": ["ResponseSchemaError/requests:1"],
  "http-500-search": ["SourceRequestError/requests:1"],
  "http-500-bootstrap": ["SourceRequestError/requests:0"],
  "network-drop-search": ["SourceRequestError/requests:1"],
  "photos-two-pics": ["photos:2/requests:2"],
  "photos-empty-list": ["photos:0/requests:2"],
  "photos-incomplete-entries": ["photos:1/requests:2"],
  "photos-blocked-waf": ["WafBlockedError/requests:2"],
  "photos-blocked-ipcheck": ["RobotDetectedError/requests:2"],
  "photos-schema-violation": ["ResponseSchemaError/requests:2"],
  "photos-http-error": ["SourceRequestError/requests:2"],
  "photos-twice-one-bootstrap": ["photos:1/requests:2", "photos:1/requests:1"],
};

describe("루프백 재생 서버 (1.4)", () => {
  it("응답을 받은 순서대로 한 번씩 돌려주고 요청(헤더 순서 포함)을 기록한다", async () => {
    const { requests, result, maxConcurrent } = await withLoopbackServer(
      [
        { status: 200, setCookie: ["A=1; Path=/"], body: "first" },
        { status: 201, body: "second" },
      ],
      async (base) => {
        const r1 = await fetch(`${base}/one`, { headers: { "X-Test": "a" } });
        const r2 = await fetch(`${base}/two`, { method: "POST", body: `{"base":"${base}"}` });
        const r3 = await fetch(`${base}/three`);
        return [r1.status, await r1.text(), r1.headers.get("set-cookie"), r2.status, await r2.text(), r3.status];
      },
    );
    expect(result).toEqual([200, "first", "A=1; Path=/", 201, "second", 500]);
    expect(requests.map((r) => `${r.method} ${r.path}`)).toEqual(["GET /one", "POST /two", "GET /three"]);
    const names = requests[0]!.headers.map(([n]) => n);
    expect(names[0]).toBe("host");
    expect(names).toContain("X-Test");
    expect(requests[0]!.headers[0]![1]).toBe("{host}");
    expect(requests[1]!.body).toBe('{"base":"{base}"}');
    expect(maxConcurrent).toBe(1);
  });

  it("소켓 끊기 응답은 클라이언트에 네트워크 오류로 보인다", async () => {
    const { result } = await withLoopbackServer([{ status: 200, body: "", closeSocket: true }], async (base) => {
      return fetch(`${base}/x`).then(
        () => "응답",
        () => "오류",
      );
    });
    expect(result).toBe("오류");
  });

  it("루프백이 아닌 호스트로의 요청은 네트워크에 닿기 전에 막는다", async () => {
    await expect(loopbackOnlyFetch("https://www.courtauction.go.kr/pgj/index.on")).rejects.toThrow("외부 요청 금지");
    await expect(loopbackOnlyFetch("http://example.invalid/")).rejects.toThrow("외부 요청 금지");
  });
});

describe("어댑터 골든 생성 (1.4)", () => {
  it("사례 34개를 정의하고 이름이 겹치지 않는다", () => {
    const names = buildSourceCases().map((c) => c.name);
    expect(names).toHaveLength(34);
    expect(new Set(names).size).toBe(34);
    expect(Object.keys(EXPECTED).sort()).toEqual([...names].sort());
  });

  it("사례마다 기존 어댑터 단위 테스트와 같은 결과(물건 수·요청 수·오류 종류)를 낸다", async () => {
    const { goldens } = await generateSourceGoldens();
    for (const [name, golden] of goldens) {
      expect(golden.expected.map(summarize), name).toEqual(EXPECTED[name]);
    }
  }, 120_000);

  it("재생 응답을 모두 소비하고, 서버는 동시에 요청 하나만 받으며, 요청은 전부 루프백이다", async () => {
    const { goldens, maxConcurrent } = await generateSourceGoldens();
    for (const [name, golden] of goldens) {
      // 사례가 준비한 응답 수와 서버가 받은 요청 수가 같다(부족하면 500, 남으면 의도하지 않은 사례).
      expect(golden.requests.length, name).toBe(golden.responses.length);
      expect(maxConcurrent.get(name), name).toBe(1);
      for (const r of golden.requests) {
        expect(r.headers[0], name).toEqual(["host", "{host}"]);
        expect(JSON.stringify(r.headers), name).not.toMatch(/courtauction\.go\.kr|127\.0\.0\.1/);
      }
    }
  }, 120_000);

  it("요청은 어댑터가 실제로 보낸 헤더를 담는다(고정 UA, Node fetch 기본 헤더, 쿠키 재사용)", async () => {
    const { goldens } = await generateSourceGoldens();
    const g = goldens.get("search-single-page")!;
    const [boot, search] = g.requests;
    expect(boot!.method).toBe("GET");
    expect(boot!.path).toBe("/pgj/index.on");
    expect(search!.method).toBe("POST");
    const headers = Object.fromEntries(search!.headers.map(([n, v]) => [n.toLowerCase(), v]));
    expect(headers["user-agent"]).toMatch(/Chrome\/131/);
    expect(headers["cookie"]).toBe("JSESSIONID=golden-session; WMONID=golden-wmon");
    expect(headers["referer"]).toBe("{base}/pgj/index.on");
    expect(headers["origin"]).toBe("{base}");
    expect(headers["accept-encoding"]).toBe("gzip, deflate");
    expect(headers["accept-language"]).toBe("*");
    expect(headers["sec-fetch-mode"]).toBe("cors");
    expect(JSON.parse(search!.body).dma_pageInfo).toMatchObject({ pageNo: 1, pageSize: 40, totalYn: "Y" });
    // 고정 시각 2026-10-08, 창 60일
    expect(JSON.parse(search!.body).dma_srchGdsDtlSrchInfo).toMatchObject({ bidBgngYmd: "20261008", bidEndYmd: "20261207" });
  }, 60_000);

  it("페이지 사이 대기는 기록만 하고(5초), 요청 순서와 함께 남는다", async () => {
    const { goldens } = await generateSourceGoldens();
    expect(goldens.get("search-three-pages")!.sleeps).toEqual([
      { ms: 5000, afterRequests: 2 },
      { ms: 5000, afterRequests: 3 },
    ]);
    expect(goldens.get("search-two-courts")!.sleeps).toEqual([{ ms: 5000, afterRequests: 2 }]);
    expect(goldens.get("photos-twice-one-bootstrap")!.requests.map((r) => r.path)).toEqual([
      "/pgj/index.on",
      "/pgj/pgj15B/selectAuctnCsSrchRslt.on",
      "/pgj/pgj15B/selectAuctnCsSrchRslt.on",
    ]);
  }, 60_000);

  it("결정적이고, 커밋된 골든과 바이트까지 같다", async () => {
    const first = await generateSourceGoldens();
    const second = await generateSourceGoldens();
    expect([...second.files]).toEqual([...first.files]);

    const committed = readdirSync(SOURCE_CONTRACTS_DIR).filter((f) => f.endsWith(".json")).sort();
    expect(committed).toEqual([...first.files.keys()].sort());
    for (const [name, text] of first.files) {
      expect(text, name).toBe(readFileSync(path.join(SOURCE_CONTRACTS_DIR, name), "utf8"));
    }
  }, 120_000);
});
