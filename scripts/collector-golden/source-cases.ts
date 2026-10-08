/**
 * 어댑터 골든 사례 정의 (port-collector-to-spring D5 사례 목록).
 *
 * 각 사례는 어댑터 옵션, 호출(검색 또는 사진 조회), 루프백 서버가 순서대로 돌려줄 응답이다.
 * 입력은 가림 처리된 픽스처(fixtures.ts)만 쓴다. 기대값은 여기 없고 생성기가 TS 어댑터를 실제로
 * 돌려 채운다.
 */
import { buildFixtureSet, type FixtureSet } from "./fixtures";
import type { ReplayResponse } from "./loopback";
import { validBody, validDetailBody } from "../../src/lib/sources/courtauction/__tests__/fixtures";

type Json = Record<string, unknown>;

export interface CourtRefDef {
  name: string;
  courtCode: string;
}

export interface SourceCaseOptions {
  pageSize?: number;
  pageDelayMs?: number;
  bidWindowDays?: number;
  maxPages?: number;
}

export type SourceCall =
  | { kind: "activeItems"; scope: { courts: CourtRefDef[] } }
  | { kind: "photos"; ref: { courtCode: string; internalCaseNo: string } };

export interface SourceCaseDef {
  name: string;
  description: string;
  options: SourceCaseOptions;
  call: SourceCall;
  /** 같은 어댑터 인스턴스로 호출을 반복하는 횟수(세션 재사용 확인용). */
  repeat: number;
  responses: ReplayResponse[];
}

/** 모든 사례가 쓰는 고정 시각. UTC 정오라 UTC-11~UTC+11 어느 시간대에서 생성해도 로컬 날짜가 같다(어댑터는 로컬 날짜로 매각기일 창을 만든다). */
export const GOLDEN_NOW = "2026-10-08T12:00:00.000Z";

const C1: CourtRefDef = { name: "서울중앙지방법원", courtCode: "B000210" };
const C2: CourtRefDef = { name: "서울동부지방법원", courtCode: "B000211" };
const PHOTO_REF = { courtCode: "B000210", internalCaseNo: "20260130101037" };

const COOKIES = ["JSESSIONID=golden-session; Path=/; HttpOnly", "WMONID=golden-wmon; Path=/"];

const bootstrap = (): ReplayResponse => ({ status: 200, setCookie: COOKIES, body: "<html><body>index</body></html>" });
const bootstrapNoCookie = (): ReplayResponse => ({ status: 200, body: "<html></html>" });
const page = (rows: Json[], totalCnt?: number | string): ReplayResponse => ({
  status: 200,
  body: validBody({ rows, ...(totalCnt !== undefined ? { totalCnt } : {}) }),
});
const raw = (body: string, status = 200): ReplayResponse => ({ status, body });
const detail = (fx: FixtureSet, pics: Json[] = fx.detailResponse.pics): ReplayResponse => ({
  status: 200,
  body: validDetailBody({ baseInfo: fx.detailResponse.baseInfo, pics }),
});

/** 다른 법원 소속으로 바꾼 행(법원 사이 대기·합산 사례용). */
const rowOfCourt = (row: Json, court: CourtRefDef, caseNo: string): Json => ({
  ...row,
  jiwonNm: court.name,
  boCd: court.courtCode,
  srnSaNo: caseNo,
});

export function buildSourceCases(fx: FixtureSet = buildFixtureSet()): SourceCaseDef[] {
  const { realRow, bundleRows, roadOnlyRow, noExtendedFieldsRow, missingKeyRow } = fx.searchRows;
  const b = fx.bodies;
  const search = (
    name: string,
    description: string,
    responses: ReplayResponse[],
    options: SourceCaseOptions = {},
    courts: CourtRefDef[] = [C1],
  ): SourceCaseDef => ({
    name,
    description,
    options,
    call: { kind: "activeItems", scope: { courts } },
    repeat: 1,
    responses,
  });
  const photos = (name: string, description: string, responses: ReplayResponse[], repeat = 1): SourceCaseDef => ({
    name,
    description,
    options: {},
    call: { kind: "photos", ref: PHOTO_REF },
    repeat,
    responses,
  });

  const zeroRow: Json = {
    ...realRow,
    srnSaNo: "2026타경7001",
    saNo: "20260130007001",
    yuchalCnt: "0",
    minArea: "0",
    maxArea: "0",
    notifyMinmaePrice2: "0",
    notifyMinmaePriceRate1: "0",
    maeGiilCnt: "0",
  };
  const rawCodeRow: Json = {
    ...realRow,
    srnSaNo: "2026타경7002",
    saNo: "20260130007002",
    lclsUtilCd: "020000",
    jinstatCd: "0002100002",
    mulStatcd: "00",
    xCordi: " 312690.55 ",
    yCordi: "555963",
    cordiLvl: "03",
    maeHh1: "0930",
    dupSaNo: "2015타경14083<br/>2021타경102844",
  };
  const tinyPic: Json = { cortAuctnPicSeq: "1", picFile: "R0lGODlhAQABAAAAACw=" };

  return [
    search("search-single-page", "정상 1페이지: 실제 응답 행, 일괄매각 3행(접힘), 도로명만 있는 행", [
      bootstrap(),
      page([realRow, ...bundleRows, roadOnlyRow]),
    ]),
    search(
      "search-three-pages",
      "totalCnt(행 수) 기준 3페이지. groupTotalCount는 페이지 수 계산에 쓰이지 않는다. 페이지 사이 대기 2회",
      [
        bootstrap(),
        { status: 200, body: validBody({ rows: [realRow, bundleRows[0]!], totalCnt: 5, groupTotalCount: 3 }) },
        { status: 200, body: validBody({ rows: [bundleRows[1]!, bundleRows[2]!], totalCnt: 5, groupTotalCount: 3 }) },
        { status: 200, body: validBody({ rows: [roadOnlyRow], totalCnt: 5, groupTotalCount: 3 }) },
      ],
      { pageSize: 2 },
    ),
    search(
      "search-empty-page-early-stop",
      "총건수상 3페이지지만 2페이지가 비면 거기서 멈춘다",
      [bootstrap(), page([realRow, bundleRows[0]!], 6), page([], 6)],
      { pageSize: 2 },
    ),
    search(
      "search-max-pages-cap",
      "maxPages 상한(2)에 걸리면 거기서 멈추고 실제 요청 수만 센다",
      [bootstrap(), page([realRow, bundleRows[0]!], 10), page([bundleRows[1]!, bundleRows[2]!], 10)],
      { pageSize: 2, maxPages: 2 },
    ),
    search("search-page-size-clamp", "pageSize가 서버 상한(40)을 넘으면 40으로 낮춰 보낸다", [bootstrap(), page([realRow])], {
      pageSize: 100,
    }),
    search("search-bundle-fold", "일괄매각 3행이 물건 1건으로 접히고 주소는 지번(A) 행을 쓴다", [
      bootstrap(),
      page([...bundleRows]),
    ]),
    search("search-road-only", "도로명(R) 행만 있는 물건은 그 주소로 폴백한다", [bootstrap(), page([roadOnlyRow])]),
    search("search-no-extended-fields", "확장 필드가 없는 행과 값이 0인 행: 없음(null)과 0을 구별한다", [
      bootstrap(),
      page([noExtendedFieldsRow, zeroRow]),
    ]),
    search("search-missing-key-row-dropped", "필수 키(사건번호)가 빈 행은 결과에서 제외한다", [
      bootstrap(),
      page([realRow, missingKeyRow]),
    ]),
    search("search-raw-codes-preserved", "코드·좌표·비고는 해석 없이 문자열 원문(앞뒤 공백만 제거)으로 보존한다", [
      bootstrap(),
      page([rawCodeRow]),
    ]),
    search(
      "search-two-courts",
      "법원 2곳: 세션은 1번, 법원 사이 대기 1회",
      [
        bootstrap(),
        page([realRow]),
        page([rowOfCourt(realRow, C2, "2026타경8001")]),
      ],
      {},
      [C1, C2],
    ),
    search("search-no-session-cookie", "세션 응답에 쿠키가 없으면 Cookie 헤더 없이 계속한다", [
      bootstrapNoCookie(),
      page([realRow]),
    ]),
    search(
      "court-code-from-name",
      "설정의 courtCode가 비어 있으면 법원 이름으로 코드를 찾는다",
      [bootstrap(), page([realRow])],
      {},
      [{ name: "서울중앙지방법원", courtCode: "" }],
    ),
    search(
      "court-unknown-name",
      "알 수 없는 법원 이름: 세션 요청 뒤 검색 요청 없이 SourceRequestError",
      [bootstrap()],
      {},
      [{ name: "존재하지않는법원", courtCode: "" }],
    ),
    search("block-waf-html", "본문이 HTML(WAF)이면 WafBlockedError", [bootstrap(), raw(b.wafBlocked)]),
    search("block-ipcheck-false-with-message", "ipcheck=false + 안내 문구: RobotDetectedError", [
      bootstrap(),
      raw(b.robotBlocked),
    ]),
    search("block-ipcheck-false-no-message", "ipcheck=false, 안내 문구 없음: RobotDetectedError", [
      bootstrap(),
      raw('{"status":200,"data":{"ipcheck":false}}'),
    ]),
    search("block-on-page-2", "2페이지에서 차단되면 그 자리에서 중단한다(부분 결과 없음)", [
      bootstrap(),
      page([realRow, bundleRows[0]!], 4),
      raw(b.robotBlocked),
    ], { pageSize: 2 }),
    search(
      "block-on-second-court",
      "두 번째 법원에서 차단되면 첫 법원에서 이미 보낸 요청 수까지 합산한다",
      [bootstrap(), page([realRow]), raw(b.robotBlocked)],
      {},
      [C1, C2],
    ),
    search("schema-data-missing", "JSON이지만 data가 없으면 차단이 아니라 ResponseSchemaError", [
      bootstrap(),
      raw('{"status":200,"message":"ok"}'),
    ]),
    search("schema-violation", "dlt_srchResult가 배열이 아니면 ResponseSchemaError", [bootstrap(), raw(b.schemaViolation)]),
    search("schema-page-info-missing", "dma_pageInfo가 없으면 ResponseSchemaError", [bootstrap(), raw(b.missingPageInfo)]),
    search("schema-json-unparseable", "{ 로 시작하지만 깨진 JSON이면 ResponseSchemaError", [bootstrap(), raw('{"status":200,"data":')]),
    search("http-500-search", "검색 HTTP 500은 SourceRequestError(요청 1)", [bootstrap(), raw("Internal Server Error", 500)]),
    search("http-500-bootstrap", "세션 HTTP 500은 SourceRequestError(요청 수 0으로 취급)", [raw("Internal Server Error", 500)]),
    search("network-drop-search", "검색 중 연결이 끊기면 SourceRequestError", [bootstrap(), { status: 200, body: "", closeSocket: true }]),
    photos("photos-two-pics", "사진 2장(실측 상세 응답)", [bootstrap(), detail(fx)]),
    photos("photos-empty-list", "csPicLst가 빈 배열이면 오류가 아니라 빈 결과", [bootstrap(), detail(fx, [])]),
    photos("photos-incomplete-entries", "순번이나 이미지 데이터가 없는 항목은 제외한다", [
      bootstrap(),
      detail(fx, [
        { cortAuctnPicSeq: null, picFile: "AAAA" },
        { cortAuctnPicSeq: "1", picFile: null },
        { cortAuctnPicSeq: "2", picFile: "" },
        { cortAuctnPicSeq: "3", picFile: "BBBB" },
      ]),
    ]),
    photos("photos-blocked-waf", "상세 응답이 WAF HTML이면 WafBlockedError(요청 2)", [bootstrap(), raw(b.wafBlocked)]),
    photos("photos-blocked-ipcheck", "상세 응답 ipcheck=false면 RobotDetectedError(요청 2)", [bootstrap(), raw(b.robotBlocked)]),
    photos("photos-schema-violation", "상세 응답 형식 위반은 ResponseSchemaError", [bootstrap(), raw(b.detailSchemaViolation)]),
    photos("photos-http-error", "상세 HTTP 500은 SourceRequestError", [bootstrap(), raw("err", 500)]),
    photos(
      "photos-twice-one-bootstrap",
      "같은 어댑터로 사진 조회 2회: 세션 부트스트랩은 1번(요청 수 2, 1)",
      [bootstrap(), detail(fx, [tinyPic]), detail(fx, [tinyPic])],
      2,
    ),
  ];
}
