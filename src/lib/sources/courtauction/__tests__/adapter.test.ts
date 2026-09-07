/**
 * `CourtAuctionAdapter` 단위 테스트.
 *
 * 네트워크를 절대 타지 않는다 — `fetchFn`을 주입해 fixture 응답을 돌려준다.
 * 조사 노트(`NOTES.md`)에서 CONFIRMED로 표시된 동작만 테스트로 못 박는다.
 */
import { describe, expect, it, vi } from "vitest";

import type { CollectScope } from "@/lib/domain";

import {
  ResponseSchemaError,
  RobotDetectedError,
  SourceBlockedError,
  SourceRequestError,
  WafBlockedError,
} from "../../errors";
import type { Logger } from "../../types";
import {
  CourtAuctionAdapter,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  SEARCH_PATH,
  SESSION_BOOTSTRAP_PATH,
  USER_AGENT,
  parseSearchResponse,
} from "../adapter";
import { SEOUL_CENTRAL_DISTRICT_COURT_CODE } from "../courts";
import {
  BUNDLE_ROWS,
  MISSING_KEY_ROW,
  MISSING_PAGE_INFO_BODY,
  REAL_ROW,
  ROAD_ONLY_ROW,
  ROBOT_BLOCKED_BODY,
  SCHEMA_VIOLATION_BODY,
  WAF_BLOCKED_BODY,
  validBody,
} from "./fixtures";

const SCOPE: CollectScope = {
  courts: [{ name: "서울중앙지방법원", courtCode: SEOUL_CENTRAL_DISTRICT_COURT_CODE }],
};

interface RecordedRequest {
  url: string;
  init: RequestInit | undefined;
  body: unknown;
}

function collectingLogger(): Logger & { infos: string[]; warns: string[]; errors: string[] } {
  const infos: string[] = [];
  const warns: string[] = [];
  const errors: string[] = [];
  return {
    infos,
    warns,
    errors,
    info: (m) => infos.push(m),
    warn: (m) => warns.push(m),
    error: (m) => errors.push(m),
  };
}

/**
 * `GET /pgj/index.on`은 쿠키를 주고, `POST .../searchControllerMain.on`은
 * `searchResponses`를 순서대로 돌려주는 가짜 fetch.
 */
function fakeFetch(searchResponses: (string | Response)[]) {
  const requests: RecordedRequest[] = [];
  let searchIndex = 0;
  const fetchFn = async (url: string, init?: RequestInit): Promise<Response> => {
    requests.push({
      url,
      init,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    if (url.endsWith(SESSION_BOOTSTRAP_PATH)) {
      return new Response("<html></html>", {
        status: 200,
        headers: { "set-cookie": "JSESSIONID=abc123; Path=/; HttpOnly" },
      });
    }
    const next = searchResponses[Math.min(searchIndex, searchResponses.length - 1)];
    searchIndex += 1;
    if (next === undefined) throw new Error("테스트 fixture가 부족합니다");
    return typeof next === "string"
      ? new Response(next, { status: 200, headers: { "content-type": "application/json" } })
      : next;
  };
  return { fetchFn, requests, searchCount: () => searchIndex };
}

function makeAdapter(
  searchResponses: (string | Response)[],
  options: { pageSize?: number; logger?: Logger; maxPages?: number } = {},
) {
  const fake = fakeFetch(searchResponses);
  const sleep = vi.fn(async () => {});
  const adapter = new CourtAuctionAdapter({
    fetchFn: fake.fetchFn,
    pageSize: options.pageSize ?? DEFAULT_PAGE_SIZE,
    maxPages: options.maxPages,
    logger: options.logger ?? collectingLogger(),
    sleep,
    now: () => new Date(2026, 8, 6), // 2026-09-06 (로컬)
  });
  return { adapter, sleep, ...fake };
}

// --------------------------------------------------------------- 3단 응답 검사

describe("parseSearchResponse — 응답 3단 검사 (design.md D6)", () => {
  it("본문이 JSON이 아니면 WafBlockedError (HTTP는 200이어도)", () => {
    expect(() => parseSearchResponse(WAF_BLOCKED_BODY)).toThrow(WafBlockedError);
    try {
      parseSearchResponse(WAF_BLOCKED_BODY);
    } catch (err) {
      expect(err).toBeInstanceOf(SourceBlockedError);
      expect((err as WafBlockedError).bodyPreview).toContain("Web firewall security policies");
    }
  });

  it("data.ipcheck !== true 면 RobotDetectedError + 소스 메시지 보존", () => {
    try {
      parseSearchResponse(ROBOT_BLOCKED_BODY);
      expect.unreachable("throw했어야 한다");
    } catch (err) {
      expect(err).toBeInstanceOf(RobotDetectedError);
      expect(err).toBeInstanceOf(SourceBlockedError);
      expect((err as RobotDetectedError).sourceMessage).toContain("차단되었습니다");
    }
  });

  it("dlt_srchResult가 배열이 아니면 ResponseSchemaError + zod 이슈 상세", () => {
    try {
      parseSearchResponse(SCHEMA_VIOLATION_BODY);
      expect.unreachable("throw했어야 한다");
    } catch (err) {
      expect(err).toBeInstanceOf(ResponseSchemaError);
      const issues = (err as ResponseSchemaError).issues.join("\n");
      expect(issues).toContain("dlt_srchResult");
      expect((err as Error).message).toContain("dlt_srchResult");
    }
  });

  it("dma_pageInfo가 없으면 ResponseSchemaError", () => {
    expect(() => parseSearchResponse(MISSING_PAGE_INFO_BODY)).toThrow(ResponseSchemaError);
  });

  it("JSON이지만 data가 없으면 (차단이 아니라) ResponseSchemaError", () => {
    // data 자체가 사라진 경우까지 차단으로 오판하면 1시간 백오프에 잘못 들어간다.
    expect(() => parseSearchResponse('{"status":500,"message":"oops"}')).toThrow(
      ResponseSchemaError,
    );
    expect(() => parseSearchResponse('{"status":500}')).not.toThrow(RobotDetectedError);
  });

  it("{ 로 시작하지만 깨진 JSON이면 ResponseSchemaError", () => {
    expect(() => parseSearchResponse('{"data":')).toThrow(ResponseSchemaError);
  });

  it("정상 응답은 rows와 pageInfo를 돌려준다", () => {
    const data = parseSearchResponse(validBody());
    expect(data.dlt_srchResult).toHaveLength(5);
    expect(data.dma_pageInfo.totalCnt).toBe("5");
  });
});

// ------------------------------------------------------------------- 요청 형태

describe("CourtAuctionAdapter — 요청", () => {
  it("회차당 index.on을 1번만 호출해 쿠키를 받고 이후 요청에 재사용한다", async () => {
    const { adapter, requests } = makeAdapter([
      validBody({ rows: [REAL_ROW], totalCnt: 2, pageSize: 1 }),
      validBody({ rows: [ROAD_ONLY_ROW], totalCnt: 2, pageNo: 2, pageSize: 1 }),
    ], { pageSize: 1 });

    await adapter.fetchActiveItems(SCOPE);

    const bootstraps = requests.filter((r) => r.url.endsWith(SESSION_BOOTSTRAP_PATH));
    expect(bootstraps).toHaveLength(1);
    const searches = requests.filter((r) => r.url.endsWith(SEARCH_PATH));
    expect(searches).toHaveLength(2);
    for (const search of searches) {
      const headers = search.init?.headers as Record<string, string>;
      expect(headers.Cookie).toBe("JSESSIONID=abc123");
      expect(headers["User-Agent"]).toBe(USER_AGENT);
      expect(headers["Content-Type"]).toBe("application/json;charset=UTF-8");
    }
  });

  it("요청 바디가 NOTES §2.1 형태이고 매각기일 범위가 오늘부터 시작한다", async () => {
    const { adapter, requests } = makeAdapter([validBody({ rows: [REAL_ROW] })]);
    await adapter.fetchActiveItems(SCOPE);

    const body = requests.find((r) => r.url.endsWith(SEARCH_PATH))!.body as {
      dma_pageInfo: Record<string, unknown>;
      dma_srchGdsDtlSrchInfo: Record<string, string>;
    };
    expect(body.dma_pageInfo).toMatchObject({
      pageNo: 1,
      pageSize: DEFAULT_PAGE_SIZE,
      totalYn: "Y",
    });
    expect(body.dma_srchGdsDtlSrchInfo).toMatchObject({
      cortOfcCd: "B000210",
      cortAuctnSrchCondCd: "0004601",
      mvprpRletDvsCd: "00031R",
      cortStDvs: "1",
      bidBgngYmd: "20260906",
      bidEndYmd: "20261105", // 오늘 + 60일 (DEFAULT_BID_WINDOW_DAYS)
    });
  });

  it("pageSize가 서버 상한(40)을 넘으면 경고하고 낮춰서 보낸다", async () => {
    // pageSize=100은 실제 서버가 HTTP 400으로 거부한다 (2026-09-06 실측).
    const logger = collectingLogger();
    const { adapter, requests } = makeAdapter([validBody({ rows: [REAL_ROW] })], {
      pageSize: 100,
      logger,
    });
    await adapter.fetchActiveItems(SCOPE);
    const body = requests.find((r) => r.url.endsWith(SEARCH_PATH))!.body as {
      dma_pageInfo: { pageSize: number };
    };
    expect(body.dma_pageInfo.pageSize).toBe(MAX_PAGE_SIZE);
    expect(logger.warns.join("\n")).toContain("HTTP 400");
  });

  it("설정에 courtCode가 비어 있으면 법원 이름으로 코드를 찾는다", async () => {
    const { adapter, requests } = makeAdapter([validBody({ rows: [REAL_ROW] })]);
    await adapter.fetchActiveItems({ courts: [{ name: "서울중앙지방법원", courtCode: "" }] });
    const body = requests.find((r) => r.url.endsWith(SEARCH_PATH))!.body as {
      dma_srchGdsDtlSrchInfo: { cortOfcCd: string };
    };
    expect(body.dma_srchGdsDtlSrchInfo.cortOfcCd).toBe("B000210");
  });

  it("알 수 없는 법원 이름이면 요청을 보내지 않고 실패한다", async () => {
    const { adapter } = makeAdapter([validBody()]);
    await expect(
      adapter.fetchActiveItems({ courts: [{ name: "없는지방법원", courtCode: "" }] }),
    ).rejects.toBeInstanceOf(SourceRequestError);
  });
});

// ----------------------------------------------------------------- 페이지네이션

describe("CourtAuctionAdapter — 페이지네이션 (NOTES §5)", () => {
  it("페이지 수를 totalCnt(행 수)로 계산한다 — groupTotalCount로 계산하면 뒷 페이지를 놓친다", async () => {
    // 행 5 / 물건 2. pageSize=2 이므로 totalCnt 기준 3페이지, groupTotalCount 기준이면 1페이지.
    const page = (rows: unknown[], pageNo: number) =>
      validBody({ rows, totalCnt: 5, groupTotalCount: 2, pageNo, pageSize: 2 });
    const { adapter, sleep, searchCount } = makeAdapter(
      [
        page([REAL_ROW, BUNDLE_ROWS[0]], 1),
        page([BUNDLE_ROWS[1], BUNDLE_ROWS[2]], 2),
        page([ROAD_ONLY_ROW], 3),
      ],
      { pageSize: 2 },
    );

    const items = await adapter.fetchActiveItems(SCOPE);

    expect(searchCount()).toBe(3);
    // 페이지 사이마다 sleep — 동시 요청 금지의 근거
    expect(sleep).toHaveBeenCalledTimes(2);
    // 5행 → 3물건 (2011타경28497, 2024타경3702 일괄 3행, 2024타경2501)
    expect(items.map((i) => i.caseNo)).toEqual([
      "2011타경28497",
      "2024타경3702",
      "2024타경2501",
    ]);
  });

  it("2페이지 이후 요청은 totalYn=N, bfPageNo를 붙인다", async () => {
    const { adapter, requests } = makeAdapter(
      [
        validBody({ rows: [REAL_ROW], totalCnt: 2, pageSize: 1 }),
        validBody({ rows: [ROAD_ONLY_ROW], totalCnt: 2, pageNo: 2, pageSize: 1 }),
      ],
      { pageSize: 1 },
    );
    await adapter.fetchActiveItems(SCOPE);
    const searches = requests.filter((r) => r.url.endsWith(SEARCH_PATH));
    expect((searches[1].body as { dma_pageInfo: Record<string, unknown> }).dma_pageInfo)
      .toMatchObject({ pageNo: 2, bfPageNo: 1, totalYn: "N", totalCnt: 2 });
  });

  it("maxPages 상한을 넘으면 경고하고 거기서 멈춘다", async () => {
    const logger = collectingLogger();
    const { adapter, searchCount } = makeAdapter(
      [validBody({ rows: [REAL_ROW], totalCnt: 10, pageSize: 1 })],
      { pageSize: 1, maxPages: 2, logger },
    );
    await adapter.fetchActiveItems(SCOPE);
    expect(searchCount()).toBe(2);
    expect(logger.warns.join("\n")).toContain("페이지 상한");
  });

  it("결과가 0건이면 빈 배열이다 (실패와 구분된다)", async () => {
    const { adapter } = makeAdapter([validBody({ rows: [], totalCnt: 0 })]);
    await expect(adapter.fetchActiveItems(SCOPE)).resolves.toEqual([]);
  });
});

// ------------------------------------------------------------- 정규화 / 행 접기

describe("CourtAuctionAdapter — 정규화", () => {
  it("실제 응답 행을 AuctionItemInput으로 매핑한다 (NOTES §3.1)", async () => {
    const { adapter } = makeAdapter([validBody({ rows: [REAL_ROW] })]);
    const [item] = await adapter.fetchActiveItems(SCOPE);
    expect(item).toEqual({
      court: "서울중앙지방법원",
      caseNo: "2011타경28497",
      itemNo: "1",
      address: "서울특별시 성북구 정릉동 1032 정릉2차 대주피오레 203동 4층 401호",
      usageType: "아파트",
      appraisalPrice: 711_000_000,
      minBidPrice: 711_000_000,
      auctionDate: "2026-09-08",
      failedBidCount: 1,
      status: "유찰 1회", // 소스 필드가 아니라 yuchalCnt에서 파생한 값
    });
  });

  it("유찰 0회는 신건으로 파생한다", async () => {
    const { adapter } = makeAdapter([validBody({ rows: BUNDLE_ROWS })]);
    const [item] = await adapter.fetchActiveItems(SCOPE);
    expect(item.status).toBe("신건");
    expect(item.failedBidCount).toBe(0);
  });

  it("일괄매각 목적물 3행이 물건 1건으로 접히고 주소는 지번(addrGbncd=A)을 쓴다", async () => {
    const { adapter } = makeAdapter([validBody({ rows: BUNDLE_ROWS })]);
    const items = await adapter.fetchActiveItems(SCOPE);
    expect(items).toHaveLength(1);
    expect(items[0].address).toBe("서울특별시 종로구 종로4가 185");
  });

  it("A 행이 없으면 도로명(R) 행 주소로 폴백한다", async () => {
    const { adapter } = makeAdapter([validBody({ rows: [ROAD_ONLY_ROW] })]);
    const [item] = await adapter.fetchActiveItems(SCOPE);
    expect(item.address).toBe("서울특별시 관악구 남부순환로192길 10");
  });

  it("notifyMinmaePrice1을 최저매각가로 쓴다 (화면과 일치)", async () => {
    const { adapter } = makeAdapter([validBody({ rows: [ROAD_ONLY_ROW] })]);
    const [item] = await adapter.fetchActiveItems(SCOPE);
    expect(item.minBidPrice).toBe(358_400_000); // minmaePrice(448,000,000)가 아니다
  });

  it("notifyMinmaePrice1이 비어 있으면 minmaePrice로 폴백한다", async () => {
    const row = { ...REAL_ROW, notifyMinmaePrice1: "0", minmaePrice: "711000000" };
    const { adapter } = makeAdapter([validBody({ rows: [row] })]);
    const [item] = await adapter.fetchActiveItems(SCOPE);
    expect(item.minBidPrice).toBe(711_000_000);
  });

  it("매각기일이 YYYYMMDD가 아니면 null (조용히 잘못된 날짜를 만들지 않는다)", async () => {
    const row = { ...REAL_ROW, maeGiil: "" };
    const { adapter } = makeAdapter([validBody({ rows: [row] })]);
    const [item] = await adapter.fetchActiveItems(SCOPE);
    expect(item.auctionDate).toBeNull();
  });

  it("필수 필드가 없는 행은 제외하고 무엇이 빠졌는지 경고 로그를 남긴다", async () => {
    const logger = collectingLogger();
    const { adapter } = makeAdapter([validBody({ rows: [REAL_ROW, MISSING_KEY_ROW] })], {
      logger,
    });
    const items = await adapter.fetchActiveItems(SCOPE);
    expect(items).toHaveLength(1);
    expect(items[0].caseNo).toBe("2011타경28497");
    const warn = logger.warns.join("\n");
    expect(warn).toContain("1행을 제외");
    expect(warn).toContain("srnSaNo(사건번호) 누락");
    expect(warn).toContain("B0002102024013009999911"); // docid로 어떤 행인지 지목
  });

  it("행은 왔는데 전부 제외되면 필드명 변경 의심 경고를 남긴다", async () => {
    const logger = collectingLogger();
    const { adapter } = makeAdapter([validBody({ rows: [MISSING_KEY_ROW] })], { logger });
    await adapter.fetchActiveItems(SCOPE);
    expect(logger.warns.join("\n")).toContain("응답 필드명 변경을 의심");
  });

  it("addrGbncd 필드가 아예 없어도 주소를 잃지 않는다", async () => {
    const row = { ...REAL_ROW, addrGbncd: undefined };
    const { adapter } = makeAdapter([validBody({ rows: [row] })]);
    const [item] = await adapter.fetchActiveItems(SCOPE);
    expect(item.address).toBe(REAL_ROW.printSt);
  });
});

// ------------------------------------------------------------------- 실패 전파

describe("CourtAuctionAdapter — 실패 처리 (spec 수집 실패 처리)", () => {
  it("차단 응답은 빈 배열이 아니라 throw로 알린다", async () => {
    const { adapter } = makeAdapter([ROBOT_BLOCKED_BODY]);
    await expect(adapter.fetchActiveItems(SCOPE)).rejects.toBeInstanceOf(RobotDetectedError);
  });

  it("2페이지에서 차단되면 그 자리에서 회차를 중단한다 (부분 결과를 반환하지 않는다)", async () => {
    const { adapter, searchCount } = makeAdapter(
      [validBody({ rows: [REAL_ROW], totalCnt: 3, pageSize: 1 }), ROBOT_BLOCKED_BODY],
      { pageSize: 1 },
    );
    await expect(adapter.fetchActiveItems(SCOPE)).rejects.toBeInstanceOf(RobotDetectedError);
    expect(searchCount()).toBe(2); // 3페이지째는 시도하지 않는다
  });

  it("HTTP 5xx는 SourceRequestError", async () => {
    const { adapter } = makeAdapter([new Response("boom", { status: 503 })]);
    await expect(adapter.fetchActiveItems(SCOPE)).rejects.toBeInstanceOf(SourceRequestError);
  });

  it("네트워크 예외는 SourceRequestError로 감싸고 원인을 보존한다", async () => {
    const cause = new Error("ECONNRESET");
    const adapter = new CourtAuctionAdapter({
      fetchFn: async () => {
        throw cause;
      },
      logger: collectingLogger(),
      sleep: async () => {},
    });
    await expect(adapter.fetchActiveItems(SCOPE)).rejects.toMatchObject({
      name: "SourceRequestError",
      cause,
    });
  });

  it("세션 초기화 응답이 비정상이면 검색을 시도하지 않는다", async () => {
    let searched = false;
    const adapter = new CourtAuctionAdapter({
      fetchFn: async (url) => {
        if (url.endsWith(SEARCH_PATH)) {
          searched = true;
          return new Response(validBody(), { status: 200 });
        }
        return new Response("nope", { status: 500 });
      },
      logger: collectingLogger(),
      sleep: async () => {},
    });
    await expect(adapter.fetchActiveItems(SCOPE)).rejects.toBeInstanceOf(SourceRequestError);
    expect(searched).toBe(false);
  });
});
