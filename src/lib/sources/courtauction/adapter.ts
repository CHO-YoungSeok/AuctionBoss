/**
 * 대한민국 법원경매정보(courtauction.go.kr) 수집 어댑터.
 *
 * 조사 결과 전체는 같은 폴더의 `NOTES.md`에 있다. 이 파일은 그중 **CONFIRMED**로
 * 표시된 사실만 코드로 옮긴 것이고, 추정에 기댄 부분에는 그 자리에 근거를 적어 뒀다.
 *
 * 동작 요약:
 *  1. `GET /pgj/index.on` 1회 → 세션 쿠키 확보(회차당 1번, 이후 재사용)
 *  2. `POST /pgj/pgjsearch/searchControllerMain.on` — `pageNo`만 늘리며 순차 순회
 *  3. 매 응답을 3단으로 검사(본문 첫 글자 → `ipcheck` → zod) — design.md D6
 *  4. (사건, 물건, 목적물) 행을 (법원, 사건번호, 물건번호) 물건 단위로 접기
 *
 * 요청 예절: 동시 요청 없음(전부 await 직렬), 페이지 사이 수 초 sleep. 로봇탐지가
 * "5분에 15회 미만"으로도 걸린 적이 있어(NOTES §6.1) 페이지 크기를 크게 잡아
 * 요청 횟수 자체를 줄인다.
 */
import type { AuctionItemInput, CollectScope, CourtRef } from "@/lib/domain";

import {
  ResponseSchemaError,
  RobotDetectedError,
  SourceRequestError,
  WafBlockedError,
  attachPagesRequested,
} from "../errors";
import {
  consoleLogger,
  type AuctionSource,
  type FetchActiveItemsResult,
  type Logger,
} from "../types";
import { courtCodeByName } from "./courts";
import {
  detailDataSchema,
  searchDataSchema,
  type DetailBaseInfo,
  type DetailData,
  type DetailPicItem,
  type DetailResult,
  type SearchRow,
} from "./schema";

export type { DetailBaseInfo, DetailData, DetailPicItem, DetailResult };

export const BASE_URL = "https://www.courtauction.go.kr";
export const SESSION_BOOTSTRAP_PATH = "/pgj/index.on";
export const SEARCH_PATH = "/pgj/pgjsearch/searchControllerMain.on";
export const DETAIL_PATH = "/pgj/pgj15B/selectAuctnCsSrchRslt.on";

/**
 * 브라우저 User-Agent. curl 기본 UA를 쓰면 WAF가 JSON 대신 HTML 차단 페이지를
 * HTTP 200으로 돌려준다 (NOTES §6.1, CONFIRMED). 고정 문자열로 둔다.
 */
export const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/**
 * 한 요청으로 가져올 수 있는 **행** 수의 상한.
 *
 * ⚠️ 서버가 큰 pageSize를 거부한다. `pageSize=100`으로 보내면 HTTP **400**
 * (`errors.errorMessage: "사용에 불편을 드려서 죄송합니다..."`)이 온다 —
 * 2026-09-06 실측 CONFIRMED. UI의 페이지 크기 셀렉트가 제공하는 값은
 * 10/20/30/40뿐이고(PGJ151M01.xml의 `pgjUtil.setCookie('pageCnt', ...)`),
 * 40은 실제 호출로 200 + 40행 수신을 확인했다.
 */
export const MAX_PAGE_SIZE = 40;

/** 한 요청으로 가져오는 **행** 수. 요청 횟수를 줄이려고 허용 최대치를 쓴다. */
export const DEFAULT_PAGE_SIZE = MAX_PAGE_SIZE;
/** 페이지 사이 대기(ms). 로봇탐지 임계가 불명이라 보수적으로 잡는다. */
export const DEFAULT_PAGE_DELAY_MS = 5_000;
/**
 * "진행 중" 물건을 표현하는 매각기일 범위 길이(일).
 * `bidBgngYmd = 오늘`, `bidEndYmd = 오늘 + 이 값`. 조정용 상수다.
 * (NOTES §6.2 row 0 — 진행상태 전용 파라미터를 못 찾아 기일 범위로 대신한다)
 */
export const DEFAULT_BID_WINDOW_DAYS = 60;
/** 폭주 방지용 페이지 상한. 여기 걸리면 경고 로그를 남기고 멈춘다. */
export const DEFAULT_MAX_PAGES = 50;

/** 검색조건 코드 — 부동산 물건상세검색 (NOTES §2.2, 이 조합으로 실제 응답 수신 CONFIRMED) */
const SEARCH_COND_REALTY = "0004601";
/** 동산/부동산 구분 — 부동산 */
const MOVABLE_REALTY_DIVISION_REALTY = "00031R";
/** 검색 기준 — 1=법원/담당계 */
const COURT_STANDARD_DIVISION = "1";
/** 입찰구분. 관측값 그대로 (정확한 의미는 NOTES §6.2 row 3에서 UNVERIFIED) */
const BID_DIVISION_CODE = "000331";
/** 화면 ID. 프론트가 보내는 값을 그대로 흉내 낸다 */
const PROGRAM_ID = "PGJ15AF01";

/** `fetch` 호환 함수. 테스트는 여기에 가짜를 넣어 네트워크를 타지 않는다. */
export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export interface CourtAuctionAdapterOptions {
  fetchFn?: FetchFn;
  baseUrl?: string;
  pageSize?: number;
  pageDelayMs?: number;
  bidWindowDays?: number;
  maxPages?: number;
  logger?: Logger;
  /** 테스트에서 실제로 기다리지 않기 위해 주입한다. */
  sleep?: (ms: number) => Promise<void>;
  /** 테스트에서 "오늘"을 고정하기 위해 주입한다. */
  now?: () => Date;
}

/**
 * pageSize를 서버가 받아 주는 범위로 낮춘다. 초과분을 조용히 무시하지 않고 경고를
 * 남기는 이유: 설정 실수로 회차 전체가 HTTP 400으로 죽는 것보다, 왜 값이 바뀌었는지
 * 알려 주고 수집을 계속하는 편이 낫기 때문이다.
 */
function clampPageSize(requested: number, logger: Logger | undefined): number {
  const size = Math.max(1, Math.trunc(requested));
  if (size <= MAX_PAGE_SIZE) return size;
  (logger ?? consoleLogger).warn(
    `[courtauction] pageSize=${size}는 서버가 거부합니다(HTTP 400). ${MAX_PAGE_SIZE}로 낮춥니다.`,
  );
  return MAX_PAGE_SIZE;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** `YYYYMMDD`. 사이트가 한국 서비스라 프로세스 로컬 날짜를 쓴다. */
function toYmd(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}${m}${d}`;
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date.getTime());
  next.setDate(next.getDate() + days);
  return next;
}

/** `YYYYMMDD` → `YYYY-MM-DD`. 형식이 아니면 null(값이 없거나 `""`인 경우 포함). */
function toIsoDate(ymd: string | null | undefined): string | null {
  if (!ymd) return null;
  const trimmed = ymd.trim();
  if (!/^\d{8}$/.test(trimmed)) return null;
  return `${trimmed.slice(0, 4)}-${trimmed.slice(4, 6)}-${trimmed.slice(6, 8)}`;
}

/** 문자열/숫자로 오는 수치를 정수로. 빈 값·비수치는 null. */
function toInt(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? Math.trunc(value) : null;
  const cleaned = value.replace(/,/g, "").trim();
  if (cleaned === "") return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}

function text(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * 가격·면적·회차율처럼 **0이 "값 없음"을 의미하는** 확장 필드용 정수 변환(design.md D3).
 * `toInt`가 0을 그대로 돌려주는 것과 달리 0을 null로 접는다.
 *
 * ⚠️ `failedBidCount`(유찰횟수)에는 쓰지 않는다 — 그 필드는 0이 유효값(신건)이라
 * 일반 `toInt`를 그대로 쓴다. 확장 필드 중 `auctionRound`(매각기일 회차)도 이 함수를
 * 쓴다 — 관측된 값이 전부 1 이상이라 회차가 0부터 시작한다는 근거가 없고, 유찰횟수처럼
 * "0 = 정상적인 첫 상태"라는 도메인 의미가 확인되지 않았기 때문이다(판단 근거, task 1.2).
 */
function toIntNonZero(value: string | number | null | undefined): number | null {
  const n = toInt(value);
  return n === null || n === 0 ? null : n;
}

/**
 * 진행상태 문자열.
 *
 * ⚠️ **소스에서 오는 값이 아니라 우리가 만들어 내는 값이다(derived).** 응답에는
 * "진행상태"에 대응하는 문자열 필드가 없고, 사이트 화면도 `yuchalCnt`(유찰횟수)를
 * 포맷해서 그 컬럼을 그린다 (NOTES §3.1, PGJ151M01.xml의 `scwin.flbdCnt`):
 *   `data == 0 ? "신건" : "유찰 N회"`
 * 화면과 값을 일치시키려고 같은 규칙을 쓴다. 원시 코드 `jinstatCd`/`mulStatcd`도
 * 오지만 코드표를 못 찾아(UNVERIFIED) 쓰지 않는다.
 */
function deriveStatus(failedBidCount: number | null): string | null {
  if (failedBidCount === null) return null;
  return failedBidCount === 0 ? "신건" : `유찰 ${failedBidCount}회`;
}

interface SearchRequestBody {
  dma_pageInfo: {
    pageNo: number;
    pageSize: number;
    bfPageNo: number;
    startRowNo: string;
    totalCnt: number;
    totalYn: "Y" | "N";
    groupTotalCount: string;
  };
  dma_srchGdsDtlSrchInfo: Record<string, unknown>;
}

/** 자연 키가 같은 행들(= 목적물만 다른 행들)의 묶음. */
interface RowGroup {
  key: string;
  rows: SearchRow[];
}

export class CourtAuctionAdapter implements AuctionSource {
  private readonly fetchFn: FetchFn;
  private readonly baseUrl: string;
  private readonly pageSize: number;
  private readonly pageDelayMs: number;
  private readonly bidWindowDays: number;
  private readonly maxPages: number;
  private readonly logger: Logger;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => Date;

  constructor(options: CourtAuctionAdapterOptions = {}) {
    // globalThis.fetch를 그대로 넣지 않고 감싸는 이유: undici가 `this` 바인딩을 요구한다.
    this.fetchFn = options.fetchFn ?? ((input, init) => fetch(input, init));
    this.baseUrl = options.baseUrl ?? BASE_URL;
    this.pageSize = clampPageSize(options.pageSize ?? DEFAULT_PAGE_SIZE, options.logger);
    this.pageDelayMs = options.pageDelayMs ?? DEFAULT_PAGE_DELAY_MS;
    this.bidWindowDays = options.bidWindowDays ?? DEFAULT_BID_WINDOW_DAYS;
    this.maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
    this.logger = options.logger ?? consoleLogger;
    this.sleep = options.sleep ?? defaultSleep;
    this.now = options.now ?? (() => new Date());
  }

  async fetchActiveItems(scope: CollectScope): Promise<FetchActiveItemsResult> {
    // 회차당 쿠키는 한 번만 받는다 (NOTES §7 step 1).
    const cookie = await this.bootstrapSession();

    const items: AuctionItemInput[] = [];
    let pagesRequested = 0;
    for (const [index, court] of scope.courts.entries()) {
      if (index > 0) await this.sleep(this.pageDelayMs);
      try {
        const { rows, pagesRequested: courtPages } = await this.fetchCourtRows(court, cookie);
        pagesRequested += courtPages;
        items.push(...this.foldRowsToItems(rows, court));
      } catch (error) {
        // 이 법원에서 실패 전까지 보낸 페이지 수는 fetchCourtRows가 이미 오류에 실어
        // 뒀다(attachPagesRequested) — 여기서는 그 앞에 완료한 법원들의 합계만 더한다.
        // 차단으로 회차가 중단됐을 때 "실제로 몇 번 요청했길래 차단됐는지"를 남기려는
        // 것이다(design.md D1 정정 문단의 후속 수정) — 0으로 남기면 "요청을 안 보냈다"로
        // 읽혀 차단(요청을 보냈기 때문에 발생)과 모순된다.
        throw attachPagesRequested(error, pagesRequested);
      }
    }
    return { items, pagesRequested };
  }

  // ---------------------------------------------------------------- 세션/요청

  /**
   * `GET /pgj/index.on`으로 세션 쿠키(JSESSIONID/WMONID 등)를 받는다.
   *
   * 쿠키가 정말 필수인지는 NOTES §6.2 row 2에서 **UNVERIFIED**다(대조군 실험이
   * 이미 차단된 상태에서 진행됨). 다만 성공한 요청은 쿠키를 갖고 있었으므로,
   * 성공 사례를 그대로 재현하는 쪽을 택한다. 쿠키를 못 받아도(빈 문자열) 요청은
   * 계속 진행한다 — 여기서 실패를 만들면 확인되지 않은 가정으로 회차를 죽이게 된다.
   */
  private async bootstrapSession(): Promise<string> {
    const url = `${this.baseUrl}${SESSION_BOOTSTRAP_PATH}`;
    const response = await this.request(url, {
      method: "GET",
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    });
    if (!response.ok) {
      throw new SourceRequestError(
        `세션 초기화 요청이 실패했습니다 (HTTP ${response.status})`,
        { url, status: response.status },
      );
    }
    const cookie = readCookieHeader(response);
    if (cookie === "") {
      this.logger.warn("[courtauction] 세션 쿠키를 받지 못했습니다 — 쿠키 없이 계속합니다");
    }
    return cookie;
  }

  /**
   * 한 법원의 결과 행 전부와 실제로 요청한 페이지 수. 페이지네이션은 여기서 끝난다.
   *
   * `pagesRequested`는 매 페이지 요청을 **보내기 직전**에 갱신한다 — 그 요청 자체가
   * 차단·오류로 실패해도 "시도했다"는 사실은 남아야 하기 때문이다. 그래서 이 함수
   * 전체를 try/catch로 감싸, 어디서 실패하든 그때까지의 값을 오류에 실어(`attachPagesRequested`)
   * 다시 던진다 — 호출자(`fetchActiveItems`)가 이 법원 앞의 누적치를 더한다.
   */
  private async fetchCourtRows(
    court: CourtRef,
    cookie: string,
  ): Promise<{ rows: SearchRow[]; pagesRequested: number }> {
    const courtCode = resolveCourtCode(court);
    const { bidBgngYmd, bidEndYmd } = this.bidWindow();
    const rows: SearchRow[] = [];
    let pagesRequested = 0;

    try {
      // 첫 페이지: totalYn="Y"로 총건수까지 계산시킨다 (NOTES §5).
      pagesRequested = 1;
      const first = await this.search(this.buildBody({ courtCode, pageNo: 1, bidBgngYmd, bidEndYmd }), cookie);
      rows.push(...first.dlt_srchResult);

      // ★ 페이지 수는 totalCnt(행 수)로 계산한다. groupTotalCount(물건 수)로 계산하면
      //   일괄매각 때문에 행 수 > 물건 수라서 뒷 페이지를 통째로 놓친다 (NOTES §5).
      const totalRows = toInt(first.dma_pageInfo.totalCnt) ?? 0;
      const pageCount = totalRows > 0 ? Math.ceil(totalRows / this.pageSize) : 1;
      this.logger.info(
        `[courtauction] ${court.name}(${courtCode}) 매각기일 ${bidBgngYmd}~${bidEndYmd}: ` +
          `총 ${totalRows}행 / ${pageCount}페이지 (page 1: ${first.dlt_srchResult.length}행)`,
      );

      const lastPage = Math.min(pageCount, this.maxPages);
      if (pageCount > this.maxPages) {
        this.logger.warn(
          `[courtauction] 페이지 상한(${this.maxPages})에 걸려 ${pageCount}페이지 중 ${lastPage}페이지까지만 수집합니다`,
        );
      }

      for (let pageNo = 2; pageNo <= lastPage; pageNo += 1) {
        // 동시 요청 금지 — 반드시 순차로, 사이에 sleep을 둔다 (NOTES §6.1).
        await this.sleep(this.pageDelayMs);
        pagesRequested = pageNo;
        const page = await this.search(
          this.buildBody({
            courtCode,
            pageNo,
            bidBgngYmd,
            bidEndYmd,
            bfPageNo: pageNo - 1,
            totalYn: "N",
            totalCnt: totalRows,
          }),
          cookie,
        );
        rows.push(...page.dlt_srchResult);
        this.logger.info(
          `[courtauction] ${court.name} page ${pageNo}/${lastPage}: ${page.dlt_srchResult.length}행 (누적 ${rows.length})`,
        );
        // 총건수와 무관하게 빈 페이지가 나오면 더 볼 게 없다.
        if (page.dlt_srchResult.length === 0) break;
      }

      return { rows, pagesRequested };
    } catch (error) {
      throw attachPagesRequested(error, pagesRequested);
    }
  }

  /** "진행 중" = 오늘 이후 매각기일이 잡힌 물건 (NOTES §6.2 row 0의 실무적 해석). */
  private bidWindow(): { bidBgngYmd: string; bidEndYmd: string } {
    const today = this.now();
    return {
      bidBgngYmd: toYmd(today),
      bidEndYmd: toYmd(addDays(today, this.bidWindowDays)),
    };
  }

  private buildBody(params: {
    courtCode: string;
    pageNo: number;
    bidBgngYmd: string;
    bidEndYmd: string;
    bfPageNo?: number;
    totalYn?: "Y" | "N";
    totalCnt?: number;
  }): SearchRequestBody {
    // NOTES §2.1의 "실제로 200 + 정상 결과를 받은 바디"를 그대로 재현한 것.
    return {
      dma_pageInfo: {
        pageNo: params.pageNo,
        pageSize: this.pageSize,
        bfPageNo: params.bfPageNo ?? params.pageNo,
        startRowNo: "",
        totalCnt: params.totalCnt ?? 0,
        totalYn: params.totalYn ?? "Y",
        groupTotalCount: "",
      },
      dma_srchGdsDtlSrchInfo: {
        rletDspslSpcCondCd: "",
        bidDvsCd: BID_DIVISION_CODE,
        mvprpRletDvsCd: MOVABLE_REALTY_DIVISION_REALTY,
        cortAuctnSrchCondCd: SEARCH_COND_REALTY,
        cortOfcCd: params.courtCode,
        jdbnCd: "",
        lclDspslGdsLstUsgCd: "",
        mclDspslGdsLstUsgCd: "",
        sclDspslGdsLstUsgCd: "",
        cortStDvs: COURT_STANDARD_DIVISION,
        lafjOrderBy: "",
        pgmId: PROGRAM_ID,
        bidBgngYmd: params.bidBgngYmd,
        bidEndYmd: params.bidEndYmd,
        // 프론트는 안 보내는 값이지만, 실제로 200을 받은 요청(NOTES §2.1)에 들어 있었다.
        // 어느 필드가 필수인지 분리 검증되지 않았으므로 성공 사례를 그대로 재현한다.
        srchInfo: {},
      },
    };
  }

  /** 검색 1회. 응답 3단 검사를 통과한 `data`만 돌려준다. */
  private async search(body: SearchRequestBody, cookie: string) {
    const url = `${this.baseUrl}${SEARCH_PATH}`;
    const headers: Record<string, string> = {
      "User-Agent": USER_AGENT,
      "Content-Type": "application/json;charset=UTF-8",
      Accept: "application/json",
      Referer: `${this.baseUrl}${SESSION_BOOTSTRAP_PATH}`,
      Origin: this.baseUrl,
      "X-Requested-With": "XMLHttpRequest",
    };
    if (cookie) headers.Cookie = cookie;

    const response = await this.request(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new SourceRequestError(
        `물건 검색 요청이 실패했습니다 (HTTP ${response.status})`,
        { url, status: response.status },
      );
    }

    const raw = await response.text();
    return parseSearchResponse(raw);
  }

  /** 네트워크 예외를 전부 `SourceRequestError`로 감싼다(조용히 삼키지 않기 위해). */
  private async request(url: string, init: RequestInit): Promise<Response> {
    try {
      return await this.fetchFn(url, init);
    } catch (cause) {
      throw new SourceRequestError(`요청 중 네트워크 오류가 발생했습니다: ${url}`, { url }, { cause });
    }
  }

  // ------------------------------------------------------------- 행 → 물건 접기

  /**
   * (사건, 물건, 목적물) 행들을 물건 단위로 접는다.
   *
   * 일괄매각 물건은 목적물 수만큼 행으로 나오므로(NOTES §3), 자연 키
   * (법원, 사건번호, 물건번호) = (`jiwonNm`, `srnSaNo`, `maemulSer`)로 group by 한다.
   * NOTES §7 step 5는 소스 내부 키 (`boCd`, `saNo`, `maemulSer`)를 제안하는데,
   * 둘은 1:1이고 여기서는 DB의 UNIQUE 키와 완전히 같은 기준으로 접는 편이
   * 배치 안 중복을 확실히 없애 준다.
   */
  private foldRowsToItems(rows: SearchRow[], court: CourtRef): AuctionItemInput[] {
    const groups = new Map<string, RowGroup>();
    const dropped: string[] = [];

    for (const row of rows) {
      const courtName = text(row.jiwonNm);
      const caseNo = text(row.srnSaNo);
      const itemNo = text(row.maemulSer);
      // spec: 필수 필드 누락 항목은 결과에 포함하지 않고 경고 로그로 남긴다.
      if (!courtName || !caseNo || !itemNo) {
        const missing = [
          !courtName ? "jiwonNm(법원)" : null,
          !caseNo ? "srnSaNo(사건번호)" : null,
          !itemNo ? "maemulSer(물건번호)" : null,
        ].filter(Boolean);
        dropped.push(`${text(row.docid) ?? "(docid 없음)"}: ${missing.join(", ")} 누락`);
        continue;
      }
      const key = `${courtName} ${caseNo} ${itemNo}`;
      const group = groups.get(key);
      if (group) group.rows.push(row);
      else groups.set(key, { key, rows: [row] });
    }

    if (dropped.length > 0) {
      this.logger.warn(
        `[courtauction] ${court.name}: 필수 필드가 없어 ${dropped.length}행을 제외했습니다\n` +
          dropped.map((d) => `  - ${d}`).join("\n"),
      );
    }
    if (rows.length > 0 && groups.size === 0) {
      // 행은 왔는데 전부 버려졌다 = 필드명이 바뀌었을 가능성이 높다.
      this.logger.warn(
        `[courtauction] ${court.name}: 수신한 ${rows.length}행이 전부 제외됐습니다 — 응답 필드명 변경을 의심할 것`,
      );
    }

    const items = [...groups.values()].map((group) => this.toItem(group.rows));

    // design.md D6: 행 자체는 정상 접혔는데(자연 키는 있음) 확장 필드가 전부 비어 있으면
    // 사이트가 그 필드들의 이름을 바꿨을 가능성이 높다 — 자연키 누락 행 전체 제외 경고와
    // 같은 패턴(위)이되, 여기서는 수집을 죽이지 않고 경고만 남긴다(부가 정보이므로).
    if (items.length > 0 && items.every((item) => !hasAnyExtendedField(item))) {
      this.logger.warn(
        `[courtauction] ${court.name}: 수신한 ${items.length}건에 확장 필드가 전부 비어 있습니다 — 응답 필드명 변경을 의심할 것`,
      );
    }

    return items;
  }

  private toItem(rows: SearchRow[]): AuctionItemInput {
    // 목적물 행끼리 사건/기일/금액은 같다(NOTES §8 샘플에서 확인). 주소만 다르므로
    // 주소 외 필드는 첫 행에서 읽는다. 확장 필드도 design.md D1대로 물건당 스칼라
    // 값이라 같은 전제를 쓴다.
    const head = rows[0];
    const failedBidCount = toInt(head.yuchalCnt);
    return {
      court: text(head.jiwonNm)!,
      caseNo: text(head.srnSaNo)!,
      itemNo: text(head.maemulSer)!,
      address: pickAddress(rows),
      usageType: text(head.dspslUsgNm),
      appraisalPrice: toInt(head.gamevalAmt),
      minBidPrice: pickMinBidPrice(head),
      auctionDate: toIsoDate(head.maeGiil),
      failedBidCount,
      status: deriveStatus(failedBidCount),

      // ---- 확장 필드 (NOTES.md §11) ----
      minArea: toIntNonZero(head.minArea),
      maxArea: toIntNonZero(head.maxArea),
      buildingDescription: text(head.pjbBuldList),

      minBidPriceRound1: toIntNonZero(head.notifyMinmaePrice1),
      minBidPriceRound2: toIntNonZero(head.notifyMinmaePrice2),
      minBidPriceRound3: toIntNonZero(head.notifyMinmaePrice3),
      minBidPriceRound4: toIntNonZero(head.notifyMinmaePrice4),
      minBidPriceRateRound1: toIntNonZero(head.notifyMinmaePriceRate1),
      minBidPriceRateRound2: toIntNonZero(head.notifyMinmaePriceRate2),

      // 코드표 미확인(UNVERIFIED, design.md D4) — 해석 없이 원문 그대로.
      usageCodeLarge: text(head.lclsUtilCd),
      usageCodeMedium: text(head.mclsUtilCd),
      usageCodeSmall: text(head.sclsUtilCd),

      sido: text(head.hjguSido),
      sigungu: text(head.hjguSigu),
      dong: text(head.hjguDong),
      lotNumber: text(head.daepyoLotno),
      buildingName: text(head.buldNm),
      buildingUnit: text(head.buldList),

      // 좌표계 미확인(UNVERIFIED, design.md D4) — 숫자 변환 없이 원문 그대로.
      coordinateX: text(head.xCordi),
      coordinateY: text(head.yCordi),
      coordinateLevel: text(head.cordiLvl),

      auctionTime: text(head.maeHh1),
      auctionPlace: text(head.maePlace),
      auctionDecisionDate: toIsoDate(head.maegyuljGiil),
      auctionRound: toIntNonZero(head.maeGiilCnt),

      note: text(head.mulBigo),
      duplicateCaseNo: text(head.dupSaNo),
      mergedCaseNo: text(head.byungSaNo),
      courtDepartment: text(head.jpDeptNm),
      courtPhone: text(head.tel),

      // 코드표 미확인(UNVERIFIED, design.md D4) — 해석 없이 원문 그대로.
      statusCode: text(head.jinstatCd),
      itemStatusCode: text(head.mulStatcd),

      // ---- 상세 조회 식별자 (add-item-photos stage A, NOTES.md §10.1) ----
      // domain/types.ts의 주석 참조: dspslGdsSeq는 대응 소스 필드가 확인되지 않아
      // 의도적으로 매핑하지 않는다.
      internalCaseNo: text(head.saNo),
      courtCode: text(head.boCd),
    };
  }
}

/**
 * `toItem`이 채우는 확장 필드 이름 전부(design.md D1, NOTES.md §11).
 * "행은 왔는데 확장 필드가 전부 비었다" 경고(task 3.5)를 판정하는 데만 쓴다.
 *
 * ⚠️ `internalCaseNo`/`courtCode`(add-item-photos stage A)는 **여기 넣지 않는다.**
 * 이 상수는 §11에서 도입된 확장 필드 묶음이 통째로 사라지는 것(사이트의 필드명 변경)을
 * 잡기 위한 것이고, `internalCaseNo`/`courtCode`는 그보다 오래전부터 dedupe 키로 쓰던
 * `saNo`/`boCd`를 도메인에 노출한 것뿐이라 성격이 다르다. 넣으면
 * `NO_EXTENDED_FIELDS_ROW`(saNo/boCd는 있고 §11 필드만 없는 고정 fixture)에서
 * `hasAnyExtendedField`가 true가 되어, "확장 필드가 전부 비었다" 경고 테스트(task 3.5)가
 * 조용히 깨진다.
 */
const EXTENDED_FIELD_KEYS = [
  "minArea",
  "maxArea",
  "buildingDescription",
  "minBidPriceRound1",
  "minBidPriceRound2",
  "minBidPriceRound3",
  "minBidPriceRound4",
  "minBidPriceRateRound1",
  "minBidPriceRateRound2",
  "usageCodeLarge",
  "usageCodeMedium",
  "usageCodeSmall",
  "sido",
  "sigungu",
  "dong",
  "lotNumber",
  "buildingName",
  "buildingUnit",
  "coordinateX",
  "coordinateY",
  "coordinateLevel",
  "auctionTime",
  "auctionPlace",
  "auctionDecisionDate",
  "auctionRound",
  "note",
  "duplicateCaseNo",
  "mergedCaseNo",
  "courtDepartment",
  "courtPhone",
  "statusCode",
  "itemStatusCode",
] as const satisfies readonly (keyof AuctionItemInput)[];

/** 확장 필드가 하나라도 값을 가졌는지. 전부 null/undefined면 false. */
function hasAnyExtendedField(item: AuctionItemInput): boolean {
  return EXTENDED_FIELD_KEYS.some((key) => item[key] !== null && item[key] !== undefined);
}

/**
 * 목적물 행들 중 주소 하나를 고른다.
 *
 * 같은 물건인데 어떤 목적물은 지번주소, 어떤 목적물은 도로명주소로 표기돼 있어
 * 이어붙이면 같은 곳이 두 번 들어간다. 구분자는 `addrGbncd`
 * (`A`=지번, `R`=도로명, NOTES §3에서 10행 전부 상관관계 CONFIRMED).
 *
 * 규칙: `A` 행의 첫 `printSt` → 없으면 첫 행의 `printSt`.
 * (모든 물건에 `A` 행이 있는지는 UNVERIFIED라 폴백을 둔다. `addrGbncd` 필드가 아예
 *  안 오는 응답도 폴백으로 흡수된다.)
 */
export function pickAddress(rows: SearchRow[]): string | null {
  const jibun = rows.find((row) => text(row.addrGbncd) === "A" && text(row.printSt));
  if (jibun) return text(jibun.printSt);
  const any = rows.find((row) => text(row.printSt));
  return any ? text(any.printSt) : null;
}

/**
 * 최저매각가격.
 *
 * 화면의 "최저매각가격" 컬럼은 `notifyMinmaePrice1`을 쓴다(NOTES §3.1, 소스코드
 * CONFIRMED). 값이 없거나 0이면 `minmaePrice`로 폴백한다 — 두 필드의 정확한 정의는
 * UNVERIFIED라, 화면과 맞추되 공란이 생기지 않게 하는 절충이다.
 */
export function pickMinBidPrice(row: SearchRow): number | null {
  const notify = toInt(row.notifyMinmaePrice1);
  if (notify !== null && notify > 0) return notify;
  const fallback = toInt(row.minmaePrice);
  if (fallback !== null && fallback > 0) return fallback;
  return notify ?? fallback;
}

/** 설정의 `courtCode`가 비어 있으면 법원 이름으로 표에서 찾는다. */
function resolveCourtCode(court: CourtRef): string {
  const explicit = court.courtCode.trim();
  if (explicit) return explicit;
  const found = courtCodeByName(court.name);
  if (found) return found;
  throw new SourceRequestError(
    `법원 코드를 알 수 없습니다: "${court.name}" — config/collector.json의 courtCode를 채우세요`,
    { url: `${BASE_URL}${SEARCH_PATH}` },
  );
}

/** 응답 헤더의 Set-Cookie들을 `name=value; name=value` 형태로 모은다. */
function readCookieHeader(response: Response): string {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  const raw =
    typeof headers.getSetCookie === "function"
      ? headers.getSetCookie()
      : ((headers.get("set-cookie") ?? "") === "" ? [] : [headers.get("set-cookie")!]);
  const jar = new Map<string, string>();
  for (const entry of raw) {
    const pair = entry.split(";")[0]?.trim();
    if (!pair) continue;
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    jar.set(pair.slice(0, eq), pair.slice(eq + 1));
  }
  return [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
}

/**
 * 응답 본문 3단 검사 (design.md D6 / NOTES §7 step 4). **순서가 중요하다.**
 *
 * HTTP 상태는 차단 상황에서도 200이라 판정에 쓸 수 없다.
 *  1. 본문이 `{`로 시작하지 않으면 → WAF HTML 차단 페이지
 *  2. `data.ipcheck !== true` → 로봇탐지 IP 차단
 *  3. zod로 `data.dma_pageInfo` / `data.dlt_srchResult` 검증 → 응답 형식 변경
 *
 * 2번 전에 `data`가 객체인지부터 본다. `data` 자체가 사라진 응답까지 차단으로
 * 오판하면 1시간 백오프에 잘못 들어가기 때문이다(그건 형식 변경으로 다룬다).
 */
export function parseSearchResponse(raw: string) {
  const trimmed = raw.trimStart();
  if (!trimmed.startsWith("{")) {
    throw new WafBlockedError(
      "WAF가 JSON 대신 차단 페이지를 반환했습니다 (HTTP 200이지만 본문이 JSON이 아님)",
      trimmed.slice(0, 200),
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (cause) {
    throw new ResponseSchemaError(
      "응답 본문을 JSON으로 파싱하지 못했습니다",
      [trimmed.slice(0, 200)],
      { cause },
    );
  }

  if (typeof parsed !== "object" || parsed === null) {
    throw new ResponseSchemaError("응답 최상위가 객체가 아닙니다", [typeof parsed]);
  }
  const envelope = parsed as { data?: unknown; message?: unknown };
  if (typeof envelope.data !== "object" || envelope.data === null) {
    throw new ResponseSchemaError("응답에 data 객체가 없습니다", [
      `data = ${JSON.stringify(envelope.data)}`,
    ]);
  }

  const data = envelope.data as { ipcheck?: unknown };
  if (data.ipcheck !== true) {
    throw new RobotDetectedError(
      "로봇탐지에 걸려 차단됐습니다 (data.ipcheck !== true) — 재시도는 무의미하니 장시간 백오프가 필요합니다",
      typeof envelope.message === "string" ? envelope.message : null,
    );
  }

  const result = searchDataSchema.safeParse(data);
  if (!result.success) {
    throw new ResponseSchemaError(
      "응답 형식이 기대와 다릅니다 (사이트가 응답 구조를 바꿨을 수 있습니다)",
      result.error.issues.map(
        (issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`,
      ),
      { cause: result.error },
    );
  }
  return result.data;
}

/**
 * 상세 응답 본문 3단 검사 및 파싱 (Stage B.4 / NOTES §10.1, §10.2).
 *
 * `parseSearchResponse`와 동일한 3단 방어 체계를 거친다:
 *  1. 본문이 `{`로 시작하지 않으면 → WAF HTML 차단 페이지 (WafBlockedError)
 *  2. `data.ipcheck !== true` → 로봇탐지 IP 차단 (RobotDetectedError)
 *  3. zod로 `data.dma_result.csBaseInfo` 및 `data.dma_result.csPicLst` 검증 (ResponseSchemaError)
 */
export function parseDetailResponse(raw: string): DetailData {
  const trimmed = raw.trimStart();
  if (!trimmed.startsWith("{")) {
    throw new WafBlockedError(
      "WAF가 JSON 대신 차단 페이지를 반환했습니다 (HTTP 200이지만 본문이 JSON이 아님)",
      trimmed.slice(0, 200),
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (cause) {
    throw new ResponseSchemaError(
      "상세 응답 본문을 JSON으로 파싱하지 못했습니다",
      [trimmed.slice(0, 200)],
      { cause },
    );
  }

  if (typeof parsed !== "object" || parsed === null) {
    throw new ResponseSchemaError("응답 최상위가 객체가 아닙니다", [typeof parsed]);
  }
  const envelope = parsed as { data?: unknown; message?: unknown };
  if (typeof envelope.data !== "object" || envelope.data === null) {
    throw new ResponseSchemaError("응답에 data 객체가 없습니다", [
      `data = ${JSON.stringify(envelope.data)}`,
    ]);
  }

  const data = envelope.data as { ipcheck?: unknown };
  if (data.ipcheck !== true) {
    throw new RobotDetectedError(
      "로봇탐지에 걸려 차단됐습니다 (data.ipcheck !== true) — 재시도는 무의미하니 장시간 백오프가 필요합니다",
      typeof envelope.message === "string" ? envelope.message : null,
    );
  }

  const result = detailDataSchema.safeParse(data);
  if (!result.success) {
    throw new ResponseSchemaError(
      "상세 응답 형식이 기대와 다릅니다 (사이트가 응답 구조를 바꿨을 수 있습니다)",
      result.error.issues.map(
        (issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`,
      ),
      { cause: result.error },
    );
  }
  return result.data;
}

/**
 * base64 문자열 또는 Buffer의 매직 바이트를 검사해 이미지 확장자를 반환한다.
 *
 * 실측 발견사항 (NOTES.md §10.2):
 * 법원경매 사이트는 `picTitlNm`이 .jpg여도 실제 바이너리는 `GIF89a` 포맷으로 반환한다.
 * 파일 저장 시 이 함수로 매직 바이트 기반 확장자를 결정한다.
 */
export function detectImageExtension(base64OrBuffer: string | Buffer): "gif" | "png" | "jpg" | "bin" {
  let buf: Buffer;
  if (typeof base64OrBuffer === "string") {
    // base64 앞 32자만 디코딩해도 매직 바이트(최대 8바이트) 판별에 충분하다
    buf = Buffer.from(base64OrBuffer.slice(0, 32), "base64");
  } else {
    buf = base64OrBuffer;
  }
  if (buf.length >= 3 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
    return "gif";
  }
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return "png";
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return "jpg";
  }
  return "bin";
}
