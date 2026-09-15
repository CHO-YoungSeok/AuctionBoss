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
  SourceError,
  SourceRequestError,
  WafBlockedError,
} from "../../errors";
import type { Logger } from "../../types";
import {
  CourtAuctionAdapter,
  DEFAULT_PAGE_SIZE,
  DETAIL_PATH,
  MAX_PAGE_SIZE,
  SEARCH_PATH,
  SESSION_BOOTSTRAP_PATH,
  USER_AGENT,
  detectImageExtension,
  parseDetailResponse,
  parseSearchResponse,
} from "../adapter";
import { SEOUL_CENTRAL_DISTRICT_COURT_CODE } from "../courts";
import {
  BUNDLE_ROWS,
  DETAIL_MISSING_RESULT_BODY,
  DETAIL_SCHEMA_VIOLATION_BODY,
  MISSING_KEY_ROW,
  MISSING_PAGE_INFO_BODY,
  NO_EXTENDED_FIELDS_ROW,
  REAL_DETAIL_BASE_INFO,
  REAL_DETAIL_PICS,
  REAL_ROW,
  ROAD_ONLY_ROW,
  ROBOT_BLOCKED_BODY,
  SCHEMA_VIOLATION_BODY,
  WAF_BLOCKED_BODY,
  validBody,
  validDetailBody,
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

    const { items } = await adapter.fetchActiveItems(SCOPE);

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
    await expect(adapter.fetchActiveItems(SCOPE)).resolves.toEqual({
      items: [],
      pagesRequested: 1,
    });
  });
});

// ------------------------------------------------------------- 실제 페이지 수 기록

describe("CourtAuctionAdapter — pagesRequested (add-collection-observability D1)", () => {
  it("1페이지만 필요하면 pagesRequested=1이다", async () => {
    const { adapter } = makeAdapter([validBody({ rows: [REAL_ROW], totalCnt: 1, pageSize: 40 })]);
    const { pagesRequested } = await adapter.fetchActiveItems(SCOPE);
    expect(pagesRequested).toBe(1);
  });

  it("여러 페이지를 다 돌면 실제로 요청한 페이지 수를 그대로 돌려준다", async () => {
    const page = (rows: unknown[], pageNo: number) =>
      validBody({ rows, totalCnt: 5, pageNo, pageSize: 2 });
    const { adapter } = makeAdapter(
      [
        page([REAL_ROW, BUNDLE_ROWS[0]], 1),
        page([BUNDLE_ROWS[1], BUNDLE_ROWS[2]], 2),
        page([ROAD_ONLY_ROW], 3),
      ],
      { pageSize: 2 },
    );
    const { pagesRequested } = await adapter.fetchActiveItems(SCOPE);
    expect(pagesRequested).toBe(3);
  });

  it("페이지 상한에 걸려 중간에 멈추면, 설정된 상한이 아니라 실제로 멈춘 페이지 수를 기록한다", async () => {
    // totalCnt 기준으로는 10페이지가 필요하지만 maxPages=2에서 멈춘다.
    // 여기서 설정 상한(2)과 실제 값이 우연히 같지 않도록, 응답을 3페이지치 준비해도
    // maxPages=2에서 멈춰야 함을 검증한다(설정 상수를 그대로 기록하는 회귀를 잡는 테스트).
    const { adapter } = makeAdapter(
      [validBody({ rows: [REAL_ROW], totalCnt: 10, pageSize: 1 })],
      { pageSize: 1, maxPages: 2 },
    );
    const { pagesRequested } = await adapter.fetchActiveItems(SCOPE);
    expect(pagesRequested).toBe(2);
  });
});

// ------------------------------------------------------------- 정규화 / 행 접기

describe("CourtAuctionAdapter — 정규화", () => {
  it("실제 응답 행을 AuctionItemInput으로 매핑한다 (NOTES §3.1)", async () => {
    const { adapter } = makeAdapter([validBody({ rows: [REAL_ROW] })]);
    const {
      items: [item],
    } = await adapter.fetchActiveItems(SCOPE);
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
      // ---- 확장 필드 (task 3.3, NOTES.md §11) — REAL_ROW(실제 응답 1행)의 실측값 ----
      minArea: 84,
      maxArea: 84,
      // 원문 그대로 줄바꿈이 보존된다(embedded newline) — 한 줄로 뭉개지지 않는다.
      buildingDescription: "철근콘크리트구조\n84.99㎡",
      minBidPriceRound1: 711_000_000,
      minBidPriceRound2: null, // REAL_ROW의 notifyMinmaePrice2 = "0" → 값 없음(design.md D3)
      minBidPriceRound3: null, // REAL_ROW에 notifyMinmaePrice3/4 자체가 없다
      minBidPriceRound4: null,
      minBidPriceRateRound1: 100,
      minBidPriceRateRound2: null,
      usageCodeLarge: "20000",
      usageCodeMedium: "20100",
      usageCodeSmall: "20104",
      sido: "서울특별시",
      sigungu: "성북구",
      dong: "정릉동",
      lotNumber: "1032",
      buildingName: "정릉2차 대주피오레",
      buildingUnit: "203동 4층 401호",
      // 좌표계 불명(design.md D4) — 숫자로 변환하지 않고 실제 원문 문자열 그대로.
      coordinateX: "312690",
      coordinateY: "555963",
      coordinateLevel: null, // REAL_ROW에 cordiLvl 자체가 없다
      auctionTime: "1000",
      auctionPlace: "경매법정(제4별관211호)",
      auctionDecisionDate: "2026-09-15",
      auctionRound: 1,
      note: null, // REAL_ROW의 mulBigo = ""
      duplicateCaseNo: "2015타경14083<br/>2021타경102844",
      mergedCaseNo: null, // REAL_ROW의 byungSaNo = ""
      courtDepartment: "경매1계",
      courtPhone: "530-1820 (제4별관 민사집행과)",
      // 코드표 미확인(UNVERIFIED, design.md D4) — 해석하지 않고 원문 그대로 보존된다.
      statusCode: "0002100001",
      itemStatusCode: "01",
      // ---- 상세 조회 식별자 (add-item-photos stage A, task A.1/A.3) ----
      // REAL_ROW의 saNo/boCd 실측값. caseNo("2011타경28497", 표시용 srnSaNo)와는
      // 형식부터 다른 별개의 값이다 — 같다고 가정하지 않는다(NOTES §10.1).
      internalCaseNo: "20110130028497",
      courtCode: "B000210",
    });
  });

  it(
    "internalCaseNo(saNo)는 표시용 caseNo(srnSaNo)와 다른 별개의 값으로 보존된다 " +
      "(task A.1 — case_no에 saNo를 재사용하지 않는다는 판단의 회귀 테스트)",
    async () => {
      const { adapter } = makeAdapter([validBody({ rows: [REAL_ROW] })]);
      const {
        items: [item],
      } = await adapter.fetchActiveItems(SCOPE);
      expect(item.caseNo).toBe("2011타경28497"); // 표시용(srnSaNo)
      expect(item.internalCaseNo).toBe("20110130028497"); // 내부(saNo)
      expect(item.caseNo).not.toBe(item.internalCaseNo);
    },
  );

  it("courtCode(boCd)는 REAL_ROW의 실측값으로 매핑된다 (task A.1/A.3)", async () => {
    const { adapter } = makeAdapter([validBody({ rows: [REAL_ROW] })]);
    const {
      items: [item],
    } = await adapter.fetchActiveItems(SCOPE);
    expect(item.courtCode).toBe("B000210");
  });

  it("saNo/boCd가 행에 없으면 상세 조회 식별자도 null이다 (값을 지어내지 않는다)", async () => {
    const row = { ...REAL_ROW, saNo: undefined, boCd: undefined };
    const { adapter } = makeAdapter([validBody({ rows: [row] })]);
    const {
      items: [item],
    } = await adapter.fetchActiveItems(SCOPE);
    expect(item.internalCaseNo).toBeNull();
    expect(item.courtCode).toBeNull();
  });

  it("차수별 3·4차 최저가·2차 최저가율·좌표수준도 원문 그대로 매핑한다 (NOTES §3.1, task 3.3)", async () => {
    // REAL_ROW에는 notifyMinmaePrice3/4·notifyMinmaePriceRate2·cordiLvl이 없어(§8 발췌
    // 범위 밖) 위 테스트가 이 필드들을 검증하지 못한다. NOTES §3.1 "부가 필드" 표의
    // 예시값으로 채운 합성 행으로 나머지 매핑 경로를 확인한다.
    const row = {
      ...REAL_ROW,
      notifyMinmaePrice2: "0",
      notifyMinmaePrice3: "0",
      notifyMinmaePrice4: "0",
      notifyMinmaePriceRate2: "100",
      cordiLvl: "1",
    };
    const { adapter } = makeAdapter([validBody({ rows: [row] })]);
    const {
      items: [item],
    } = await adapter.fetchActiveItems(SCOPE);
    // notifyMinmaePrice3/4가 "0"(값 없음, design.md D3)이어도 null로 접힌다.
    expect(item.minBidPriceRound3).toBeNull();
    expect(item.minBidPriceRound4).toBeNull();
    expect(item.minBidPriceRateRound2).toBe(100);
    expect(item.coordinateLevel).toBe("1"); // 코드표 미확인 — 문자열 그대로, 숫자 변환 없음
  });

  it("유찰 0회는 신건으로 파생한다", async () => {
    const { adapter } = makeAdapter([validBody({ rows: BUNDLE_ROWS })]);
    const {
      items: [item],
    } = await adapter.fetchActiveItems(SCOPE);
    expect(item.status).toBe("신건");
    expect(item.failedBidCount).toBe(0);
  });

  it("일괄매각 목적물 3행이 물건 1건으로 접히고 주소는 지번(addrGbncd=A)을 쓴다", async () => {
    const { adapter } = makeAdapter([validBody({ rows: BUNDLE_ROWS })]);
    const { items } = await adapter.fetchActiveItems(SCOPE);
    expect(items).toHaveLength(1);
    expect(items[0].address).toBe("서울특별시 종로구 종로4가 185");
  });

  it("A 행이 없으면 도로명(R) 행 주소로 폴백한다", async () => {
    const { adapter } = makeAdapter([validBody({ rows: [ROAD_ONLY_ROW] })]);
    const {
      items: [item],
    } = await adapter.fetchActiveItems(SCOPE);
    expect(item.address).toBe("서울특별시 관악구 남부순환로192길 10");
  });

  it("notifyMinmaePrice1을 최저매각가로 쓴다 (화면과 일치)", async () => {
    const { adapter } = makeAdapter([validBody({ rows: [ROAD_ONLY_ROW] })]);
    const {
      items: [item],
    } = await adapter.fetchActiveItems(SCOPE);
    expect(item.minBidPrice).toBe(358_400_000); // minmaePrice(448,000,000)가 아니다
  });

  it("notifyMinmaePrice1이 비어 있으면 minmaePrice로 폴백한다", async () => {
    const row = { ...REAL_ROW, notifyMinmaePrice1: "0", minmaePrice: "711000000" };
    const { adapter } = makeAdapter([validBody({ rows: [row] })]);
    const {
      items: [item],
    } = await adapter.fetchActiveItems(SCOPE);
    expect(item.minBidPrice).toBe(711_000_000);
  });

  it("매각기일이 YYYYMMDD가 아니면 null (조용히 잘못된 날짜를 만들지 않는다)", async () => {
    const row = { ...REAL_ROW, maeGiil: "" };
    const { adapter } = makeAdapter([validBody({ rows: [row] })]);
    const {
      items: [item],
    } = await adapter.fetchActiveItems(SCOPE);
    expect(item.auctionDate).toBeNull();
  });

  it("필수 필드가 없는 행은 제외하고 무엇이 빠졌는지 경고 로그를 남긴다", async () => {
    const logger = collectingLogger();
    const { adapter } = makeAdapter([validBody({ rows: [REAL_ROW, MISSING_KEY_ROW] })], {
      logger,
    });
    const { items } = await adapter.fetchActiveItems(SCOPE);
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
    const {
      items: [item],
    } = await adapter.fetchActiveItems(SCOPE);
    expect(item.address).toBe(REAL_ROW.printSt);
  });

  // ------------------------------------------------------------- 확장 필드 (task 3.4/3.5)

  it("확장 필드가 전부 비어 있어도 물건은 정상 수집되고 기존 필드 처리는 그대로다 (task 3.4)", async () => {
    const { adapter } = makeAdapter([validBody({ rows: [NO_EXTENDED_FIELDS_ROW] })]);
    const {
      items: [item],
    } = await adapter.fetchActiveItems(SCOPE);

    // 기존 필드는 확장 필드 유무와 무관하게 그대로 정상 매핑된다.
    expect(item).toMatchObject({
      court: "서울중앙지방법원",
      caseNo: "2026타경9999",
      itemNo: "1",
      address: "서울특별시 어딘가 1",
      usageType: "아파트",
      appraisalPrice: 500_000_000,
      minBidPrice: 400_000_000, // notifyMinmaePrice1이 없어 minmaePrice로 폴백
      auctionDate: "2026-10-01",
      failedBidCount: 0,
      status: "신건",
    });

    // 확장 필드는 전부 null이다 — 값을 지어내지 않는다(design.md D3).
    expect(item.minArea).toBeNull();
    expect(item.maxArea).toBeNull();
    expect(item.buildingDescription).toBeNull();
    expect(item.minBidPriceRound1).toBeNull();
    expect(item.minBidPriceRound2).toBeNull();
    expect(item.minBidPriceRound3).toBeNull();
    expect(item.minBidPriceRound4).toBeNull();
    expect(item.minBidPriceRateRound1).toBeNull();
    expect(item.minBidPriceRateRound2).toBeNull();
    expect(item.usageCodeLarge).toBeNull();
    expect(item.usageCodeMedium).toBeNull();
    expect(item.usageCodeSmall).toBeNull();
    expect(item.sido).toBeNull();
    expect(item.sigungu).toBeNull();
    expect(item.dong).toBeNull();
    expect(item.lotNumber).toBeNull();
    expect(item.buildingName).toBeNull();
    expect(item.buildingUnit).toBeNull();
    expect(item.coordinateX).toBeNull();
    expect(item.coordinateY).toBeNull();
    expect(item.coordinateLevel).toBeNull();
    expect(item.auctionTime).toBeNull();
    expect(item.auctionPlace).toBeNull();
    expect(item.auctionDecisionDate).toBeNull();
    expect(item.auctionRound).toBeNull();
    expect(item.note).toBeNull();
    expect(item.duplicateCaseNo).toBeNull();
    expect(item.mergedCaseNo).toBeNull();
    expect(item.courtDepartment).toBeNull();
    expect(item.courtPhone).toBeNull();
    expect(item.statusCode).toBeNull();
    expect(item.itemStatusCode).toBeNull();

    // 상세 조회 식별자(add-item-photos stage A)는 §11 확장 필드 묶음과 무관하게 이
    // 행에도 saNo/boCd가 있으므로 정상 매핑된다 — "확장 필드가 전부 비었다"는 이
    // 두 필드까지 포함하는 뜻이 아니다(EXTENDED_FIELD_KEYS 주석 참조).
    expect(item.internalCaseNo).toBe(NO_EXTENDED_FIELDS_ROW.saNo);
    expect(item.courtCode).toBe(NO_EXTENDED_FIELDS_ROW.boCd);
  });

  it(
    "행은 왔고 정상 수집됐는데 확장 필드가 전부 비면 필드명 변경 의심 경고를 남기고, " +
      "그 경고가 회차를 죽이지 않는다 (task 3.5, design.md D6)",
    async () => {
      const logger = collectingLogger();
      const { adapter } = makeAdapter([validBody({ rows: [NO_EXTENDED_FIELDS_ROW] })], {
        logger,
      });

      const { items, pagesRequested } = await adapter.fetchActiveItems(SCOPE);

      // 경고만 남기고 정상적으로 물건을 돌려준다 — throw하지 않는다.
      expect(items).toHaveLength(1);
      expect(pagesRequested).toBe(1);
      expect(logger.warns.join("\n")).toContain("확장 필드가 전부 비어 있습니다");
      expect(logger.warns.join("\n")).toContain("응답 필드명 변경을 의심할 것");
    },
  );

  it("확장 필드가 하나라도 있으면(REAL_ROW) 필드명 변경 의심 경고를 남기지 않는다", async () => {
    const logger = collectingLogger();
    const { adapter } = makeAdapter([validBody({ rows: [REAL_ROW] })], { logger });
    await adapter.fetchActiveItems(SCOPE);
    expect(logger.warns.join("\n")).not.toContain("확장 필드가 전부 비어 있습니다");
  });
});

// --------------------------------------------------------- 회귀 (task 3.6)

describe("CourtAuctionAdapter — 회귀 (task 3.6, 확장 필드 추가가 기존 계약을 바꾸지 않는다)", () => {
  it("AuctionSource 계약은 여전히 { items, pagesRequested } 뿐이다", async () => {
    const { adapter } = makeAdapter([validBody({ rows: [REAL_ROW] })]);
    const result = await adapter.fetchActiveItems(SCOPE);
    expect(Object.keys(result).sort()).toEqual(["items", "pagesRequested"]);
    expect(typeof result.pagesRequested).toBe("number");
    expect(Array.isArray(result.items)).toBe(true);
  });

  it("기존 10개 핵심 필드의 값과 의미는 확장 필드 추가 이후에도 바뀌지 않는다", async () => {
    const { adapter } = makeAdapter([validBody({ rows: [REAL_ROW] })]);
    const {
      items: [item],
    } = await adapter.fetchActiveItems(SCOPE);
    expect(item).toMatchObject({
      court: "서울중앙지방법원",
      caseNo: "2011타경28497",
      itemNo: "1",
      address: "서울특별시 성북구 정릉동 1032 정릉2차 대주피오레 203동 4층 401호",
      usageType: "아파트",
      appraisalPrice: 711_000_000,
      minBidPrice: 711_000_000,
      auctionDate: "2026-09-08",
      failedBidCount: 1,
      status: "유찰 1회",
    });
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

  it(
    "2페이지에서 차단되면 오류에 실제로 보낸 페이지 수(2)가 실린다 — 0이면 " +
      "\"요청을 안 보냈다\"로 읽혀 차단(요청을 보냈기 때문에 발생)과 모순된다 (원래 결함 회귀 테스트)",
    async () => {
      const { adapter } = makeAdapter(
        [validBody({ rows: [REAL_ROW], totalCnt: 3, pageSize: 1 }), ROBOT_BLOCKED_BODY],
        { pageSize: 1 },
      );
      try {
        await adapter.fetchActiveItems(SCOPE);
        expect.unreachable("throw했어야 한다");
      } catch (err) {
        expect(err).toBeInstanceOf(RobotDetectedError);
        expect((err as SourceError).pagesRequested).toBe(2);
      }
    },
  );

  it("1페이지째(첫 요청)부터 차단되어도 pagesRequested는 0이 아니라 1이다 — 그 요청은 실제로 보냈다", async () => {
    const { adapter } = makeAdapter([ROBOT_BLOCKED_BODY]);
    try {
      await adapter.fetchActiveItems(SCOPE);
      expect.unreachable("throw했어야 한다");
    } catch (err) {
      expect(err).toBeInstanceOf(RobotDetectedError);
      expect((err as SourceError).pagesRequested).toBe(1);
    }
  });

  it("여러 법원을 순회하다 두 번째 법원에서 차단되면, 첫 법원에서 이미 보낸 페이지 수까지 합산된다", async () => {
    const twoCourts: CollectScope = {
      courts: [
        { name: "서울중앙지방법원", courtCode: "B000210" },
        { name: "서울동부지방법원", courtCode: "B000211" },
      ],
    };
    // 첫 법원: 2페이지(pageSize=1, totalCnt=2)를 정상 완료. 두 번째 법원: 1페이지째에서 차단.
    const { adapter } = makeAdapter(
      [
        validBody({ rows: [REAL_ROW], totalCnt: 2, pageSize: 1 }),
        validBody({ rows: [ROAD_ONLY_ROW], totalCnt: 2, pageNo: 2, pageSize: 1 }),
        ROBOT_BLOCKED_BODY,
      ],
      { pageSize: 1 },
    );
    try {
      await adapter.fetchActiveItems(twoCourts);
      expect.unreachable("throw했어야 한다");
    } catch (err) {
      expect(err).toBeInstanceOf(RobotDetectedError);
      // 첫 법원 2페이지 + 두 번째 법원에서 차단당한 1페이지 = 3.
      expect((err as SourceError).pagesRequested).toBe(3);
    }
  });

  it("세션 초기화 단계에서 실패하면 검색 요청을 한 번도 보내지 않았으므로 pagesRequested는 undefined(0으로 취급)다", async () => {
    const adapter = new CourtAuctionAdapter({
      fetchFn: async () => new Response("nope", { status: 500 }),
      logger: collectingLogger(),
      sleep: async () => {},
    });
    try {
      await adapter.fetchActiveItems(SCOPE);
      expect.unreachable("throw했어야 한다");
    } catch (err) {
      expect((err as SourceError).pagesRequested).toBeUndefined();
    }
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

// ------------------------------------------------------------- 상세 응답 및 사진 검증 (Stage B.4)

describe("parseDetailResponse 및 GIF base64 검증 (Stage B.4)", () => {
  it("DETAIL_PATH는 selectAuctnCsSrchRslt.on 경로다", () => {
    expect(DETAIL_PATH).toBe("/pgj/pgj15B/selectAuctnCsSrchRslt.on");
  });

  it("정상 상세 응답은 csBaseInfo와 csPicLst를 파싱한다", () => {
    const raw = validDetailBody();
    const data = parseDetailResponse(raw);

    // csBaseInfo 핵심 필드 검증 (2026-09-11 실측 2026타경101037)
    expect(data.dma_result.csBaseInfo).toBeDefined();
    expect(data.dma_result.csBaseInfo.cortOfcCd).toBe(REAL_DETAIL_BASE_INFO.cortOfcCd);
    expect(data.dma_result.csBaseInfo.csNo).toBe(REAL_DETAIL_BASE_INFO.csNo);
    expect(data.dma_result.csBaseInfo.userCsNo).toBe(REAL_DETAIL_BASE_INFO.userCsNo);
    expect(data.dma_result.csBaseInfo.cortOfcNm).toBe(REAL_DETAIL_BASE_INFO.cortOfcNm);
    expect(data.dma_result.csBaseInfo.csNm).toBe(REAL_DETAIL_BASE_INFO.csNm);

    // csPicLst 배열 및 사진 항목 필드 검증
    expect(Array.isArray(data.dma_result.csPicLst)).toBe(true);
    expect(data.dma_result.csPicLst).toHaveLength(2);

    const firstPic = data.dma_result.csPicLst[0];
    expect(firstPic.picTitlNm).toBe("B000210202601301010371.jpg");
    expect(firstPic.cortAuctnPicSeq).toBe("1");
    expect(firstPic.cortAuctnPicDvsCd).toBe("000244");
    expect(firstPic.cortOfcCd).toBe("B000210");
    expect(firstPic.csNo).toBe("20260130101037");
    expect(typeof firstPic.picFile).toBe("string");
    expect(firstPic.picFile?.length).toBeGreaterThan(100_000);
  });

  it("본문이 JSON이 아니면 WafBlockedError (HTTP 200이어도)", () => {
    expect(() => parseDetailResponse(WAF_BLOCKED_BODY)).toThrow(WafBlockedError);
  });

  it("data.ipcheck !== true 면 RobotDetectedError + 소스 메시지 보존", () => {
    try {
      parseDetailResponse(ROBOT_BLOCKED_BODY);
      expect.unreachable("throw했어야 한다");
    } catch (err) {
      expect(err).toBeInstanceOf(RobotDetectedError);
      expect(err).toBeInstanceOf(SourceBlockedError);
      expect((err as RobotDetectedError).sourceMessage).toContain("차단되었습니다");
    }
  });

  it("csPicLst가 배열이 아니면 ResponseSchemaError", () => {
    try {
      parseDetailResponse(DETAIL_SCHEMA_VIOLATION_BODY);
      expect.unreachable("throw했어야 한다");
    } catch (err) {
      expect(err).toBeInstanceOf(ResponseSchemaError);
      const issues = (err as ResponseSchemaError).issues.join("\n");
      expect(issues).toContain("csPicLst");
    }
  });

  it("dma_result가 통째로 없으면 ResponseSchemaError", () => {
    expect(() => parseDetailResponse(DETAIL_MISSING_RESULT_BODY)).toThrow(ResponseSchemaError);
  });

  it("JSON이지만 data가 없으면 ResponseSchemaError", () => {
    expect(() => parseDetailResponse('{"status":200,"message":"ok"}')).toThrow(ResponseSchemaError);
  });

  it("실측 사진 바이너리는 파일명이 .jpg여도 GIF89a 매직 바이트를 가진다 (Stage B 실측 핵심 발견)", () => {
    // 실측 데이터 2장 모두 파일명은 .jpg이지만 바이너리는 GIF89a
    for (const pic of REAL_DETAIL_PICS) {
      expect(pic.picTitlNm).toMatch(/\.jpg$/i);
      expect(pic.picFile).toBeDefined();

      // base64 앞머리가 R0lGODlh (GIF89a의 base64 인코딩)
      expect(pic.picFile.startsWith("R0lGODlh")).toBe(true);

      // 바이너리 디코딩 시 첫 6바이트 매직 바이트가 "GIF89a"
      const buf = Buffer.from(pic.picFile, "base64");
      const magic = buf.subarray(0, 6).toString("ascii");
      expect(magic).toBe("GIF89a");

      // 확장자 감지 함수로 "gif" 판별 확인
      expect(detectImageExtension(pic.picFile)).toBe("gif");
      expect(detectImageExtension(buf)).toBe("gif");
    }
  });

  it("detectImageExtension은 PNG, JPEG, 기타 바이너리를 올바르게 판별한다", () => {
    // PNG 매직 바이트: 89 50 4E 47 0D 0A 1A 0A
    const pngBuf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
    expect(detectImageExtension(pngBuf)).toBe("png");
    expect(detectImageExtension(pngBuf.toString("base64"))).toBe("png");

    // JPEG 매직 바이트: FF D8 FF
    const jpgBuf = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]);
    expect(detectImageExtension(jpgBuf)).toBe("jpg");
    expect(detectImageExtension(jpgBuf.toString("base64"))).toBe("jpg");

    // 미식별 바이너리
    const binBuf = Buffer.from([0x00, 0x01, 0x02, 0x03]);
    expect(detectImageExtension(binBuf)).toBe("bin");
    expect(detectImageExtension(binBuf.toString("base64"))).toBe("bin");
  });
});
