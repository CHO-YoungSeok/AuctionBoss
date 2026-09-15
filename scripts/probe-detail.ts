/**
 * scripts/probe-detail.ts
 *
 * 법원경매정보 상세 엔드포인트 단 1회 호출 실측 프로브 (Stage B.1 ~ B.2).
 *
 * 주의사항:
 * - 절대로 재시도 루프(retry loop)를 돌리지 않습니다.
 * - 단 1회만 호출하며, 차단 징후(HTTP != 200, WAF HTML, ipcheck != true) 발견 시 즉시 중단합니다.
 * - 전체 응답을 data/probe-response.json에 저장하고 사진 메타데이터를 요약 출력합니다.
 *
 * 사용법:
 *   npx tsx scripts/probe-detail.ts --dry-run
 *   npx tsx scripts/probe-detail.ts
 *   npx tsx scripts/probe-detail.ts --case-no 2024타경2532
 *   npx tsx scripts/probe-detail.ts --cs-no 20240130002532 --court-code B000210
 */
import Database from "better-sqlite3";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { courtCodeByName } from "../src/lib/sources/courtauction/courts";

export const BASE_URL = "https://www.courtauction.go.kr";
export const SESSION_BOOTSTRAP_PATH = "/pgj/index.on";
export const DETAIL_PATH = "/pgj/pgj15B/selectAuctnCsSrchRslt.on";

export const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export const DEFAULT_DB_PATH = "data/auctionboss.db";

/**
 * 한국 법원 사건번호("2024타경2532")를 내부 사건번호 saNo("20240130002532")로 변환.
 * 타경 사건부호 코드는 사법정보시스템 공통으로 0130이며, 번호는 6자리 0 패딩이다.
 */
export function deriveSaNoFromCaseNo(caseNo: string): string | null {
  const match = caseNo.trim().match(/^(\d{4})타경(\d+)$/);
  if (!match) return null;
  const [, year, seq] = match;
  return `${year}0130${seq.padStart(6, "0")}`;
}

export function readCookieHeader(response: Response): string {
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

interface TargetInfo {
  court: string;
  caseNo: string;
  itemNo: string;
  csNo: string;
  cortOfcCd: string;
  dspslGdsSeq: string;
  source: string;
}

function resolveTarget(args: Record<string, string>): TargetInfo {
  const dbPath = path.resolve(process.cwd(), process.env.AUCTIONBOSS_DB ?? DEFAULT_DB_PATH);

  let court = "서울중앙지방법원";
  let caseNo = "2026타경101037";
  let itemNo = "1";
  let csNo = "";
  let cortOfcCd = "";
  const dspslGdsSeq = args["dspsl-gds-seq"] ?? "";
  let source = "default fallback";

  if (existsSync(dbPath)) {
    try {
      const db = new Database(dbPath, { readonly: true });
      const columns = db.pragma("table_info(items)") as Array<{ name: string }>;
      const colNames = new Set(columns.map((c) => c.name));

      const hasInternalCaseNo = colNames.has("internal_case_no");
      const hasCourtCode = colNames.has("court_code");

      const selectCols = [
        "id",
        "court",
        "case_no",
        "item_no",
        "auction_date",
        hasInternalCaseNo ? "internal_case_no" : "NULL as internal_case_no",
        hasCourtCode ? "court_code" : "NULL as court_code",
      ].join(", ");

      const today = new Date().toISOString().slice(0, 10);
      let row: Record<string, unknown> | null = null;

      if (args["case-no"]) {
        row = (db.prepare(`SELECT ${selectCols} FROM items WHERE case_no = ? LIMIT 1`).get(args["case-no"]) as Record<string, unknown> | undefined) ?? null;
      } else {
        // 활성 물건(오늘 이후 기일) 중 가장 최신 물건 선택
        row = (db
          .prepare(
            `SELECT ${selectCols} FROM items WHERE auction_date >= ? ORDER BY id DESC LIMIT 1`,
          )
          .get(today) as Record<string, unknown> | undefined) ?? null;
        if (!row) {
          row = (db.prepare(`SELECT ${selectCols} FROM items ORDER BY id DESC LIMIT 1`).get() as Record<string, unknown> | undefined) ?? null;
        }
      }

      if (row) {
        court = (row.court as string) ?? court;
        caseNo = (row.case_no as string) ?? caseNo;
        itemNo = (row.item_no as string) ?? itemNo;
        if (row.internal_case_no) csNo = String(row.internal_case_no);
        if (row.court_code) cortOfcCd = String(row.court_code);
        source = `db item id=${String(row.id)} (${String(row.case_no)}, 기일: ${String(row.auction_date)})`;
      }
      db.close();
    } catch (err) {
      console.warn(`[WARN] DB 조회 중 오류 발생 (폴백 사용):`, err);
    }
  }

  // CLI override
  if (args["case-no"]) {
    caseNo = args["case-no"];
    source = `CLI argument --case-no=${caseNo}`;
  }
  if (args["court"]) {
    court = args["court"];
  }
  if (args["court-code"]) {
    cortOfcCd = args["court-code"];
  }
  if (args["cs-no"]) {
    csNo = args["cs-no"];
    source = `CLI argument --cs-no=${csNo}`;
  }

  // derive if not set
  if (!cortOfcCd) {
    cortOfcCd = courtCodeByName(court) ?? "B000210";
  }
  if (!csNo) {
    const derived = deriveSaNoFromCaseNo(caseNo);
    if (derived) {
      csNo = derived;
    } else {
      csNo = caseNo;
    }
  }

  return {
    court,
    caseNo,
    itemNo,
    csNo,
    cortOfcCd,
    dspslGdsSeq,
    source,
  };
}

function parseArgs(): { dryRun: boolean; params: Record<string, string> } {
  const rawArgs = process.argv.slice(2);
  const params: Record<string, string> = {};
  let dryRun = false;

  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i];
    if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg.startsWith("--") && i + 1 < rawArgs.length && !rawArgs[i + 1].startsWith("--")) {
      params[arg.slice(2)] = rawArgs[i + 1];
      i++;
    }
  }

  return { dryRun, params };
}

async function main() {
  const { dryRun, params } = parseArgs();
  const target = resolveTarget(params);

  console.log("==================================================================");
  console.log("   [CourtAuction Detail Endpoint Probe (add-item-photos Stage B)]");
  console.log("==================================================================");
  console.log(`- 대상 출처       : ${target.source}`);
  console.log(`- 법원            : ${target.court} (cortOfcCd: ${target.cortOfcCd})`);
  console.log(`- 표시 사건번호   : ${target.caseNo} (물건번호: ${target.itemNo})`);
  console.log(`- 요청 사건번호   : ${target.csNo} (csNo)`);
  console.log(`- dspslGdsSeq     : "${target.dspslGdsSeq}" (기본 빈 문자열)`);
  console.log(`- Base URL        : ${BASE_URL}`);
  console.log(`- Bootstrap URL   : ${BASE_URL}${SESSION_BOOTSTRAP_PATH}`);
  console.log(`- Detail URL      : ${BASE_URL}${DETAIL_PATH}`);

  const payload = {
    dma_srchGdsDtlSrch: {
      csNo: target.csNo,
      cortOfcCd: target.cortOfcCd,
      dspslGdsSeq: target.dspslGdsSeq,
      pgmId: "PGJ15BM01",
    },
  };

  console.log("\n[요청 바디 (dma_srchGdsDtlSrch)]:\n" + JSON.stringify(payload, null, 2));

  if (dryRun) {
    console.log("\n[INFO] --dry-run 옵션이 지정되어 네트워크 호출을 수행하지 않고 안전하게 종료합니다.");
    return;
  }

  const dataDir = path.resolve(process.cwd(), "data");
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
  }

  console.log("\n[Step 1] 세션 쿠키 초기화 요청 (GET /pgj/index.on)...");
  let cookie = "";
  try {
    const bootstrapRes = await fetch(`${BASE_URL}${SESSION_BOOTSTRAP_PATH}`, {
      method: "GET",
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    });

    if (!bootstrapRes.ok) {
      console.error(`[ERROR] 세션 초기화 실패: HTTP ${bootstrapRes.status}`);
      process.exit(1);
    }

    cookie = readCookieHeader(bootstrapRes);
    console.log(`[INFO] 세션 쿠키 수신 완료: ${cookie ? cookie.slice(0, 50) + "..." : "(쿠키 없음)"}`);
  } catch (err) {
    console.error(`[ERROR] 세션 초기화 네트워크 오류:`, err);
    process.exit(1);
  }

  console.log("\n[Step 2] 2초 대기 (사이트 예절 준수)...");
  await new Promise((resolve) => setTimeout(resolve, 2000));

  console.log(`\n[Step 3] 상세 엔드포인트 단 1회 호출...`);
  console.log(`POST ${BASE_URL}${DETAIL_PATH}`);

  const headers: Record<string, string> = {
    "User-Agent": USER_AGENT,
    "Content-Type": "application/json;charset=UTF-8",
    Accept: "application/json",
    Referer: `${BASE_URL}${SESSION_BOOTSTRAP_PATH}`,
    Origin: BASE_URL,
    "X-Requested-With": "XMLHttpRequest",
  };
  if (cookie) {
    headers.Cookie = cookie;
  }

  let response: Response;
  try {
    response = await fetch(`${BASE_URL}${DETAIL_PATH}`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });
  } catch (err) {
    console.error(`[ERROR] 상세 엔드포인트 네트워크 오류 발생. 재시도하지 않고 종료합니다:`, err);
    process.exit(1);
  }

  console.log(`[INFO] HTTP Status: ${response.status} ${response.statusText}`);

  const raw = await response.text();

  if (!response.ok) {
    const errPath = path.join(dataDir, `probe-error-http-${response.status}.txt`);
    writeFileSync(errPath, raw, "utf8");
    console.error(`[ERROR] HTTP ${response.status} 오류 응답. 내용을 ${errPath} 에 저장했습니다.`);
    console.error(raw.slice(0, 500));
    process.exit(1);
  }

  const trimmed = raw.trimStart();
  if (!trimmed.startsWith("{")) {
    const wafPath = path.join(dataDir, "probe-waf-blocked.html");
    writeFileSync(wafPath, raw, "utf8");
    console.error(`[ERROR] WAF 차단 징후: JSON이 아닌 HTML 응답 수신. 저장 위치: ${wafPath}`);
    console.error(raw.slice(0, 500));
    process.exit(1);
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(trimmed) as Record<string, unknown>;
  } catch (err) {
    const jsonErrPath = path.join(dataDir, "probe-invalid-json.txt");
    writeFileSync(jsonErrPath, raw, "utf8");
    console.error(`[ERROR] JSON 파싱 실패. 저장 위치: ${jsonErrPath}`, err);
    process.exit(1);
  }

  if (typeof parsed !== "object" || parsed === null) {
    console.error(`[ERROR] 응답 최상위가 객체가 아닙니다:`, typeof parsed);
    process.exit(1);
  }

  const data = parsed.data as Record<string, unknown> | undefined;
  if (!data || typeof data !== "object") {
    console.error(`[ERROR] 응답에 data 객체가 없습니다:`, parsed);
    process.exit(1);
  }

  if (data.ipcheck !== true) {
    const robotPath = path.join(dataDir, "probe-robot-blocked.json");
    writeFileSync(robotPath, JSON.stringify(parsed, null, 2), "utf8");
    console.error(`[ERROR] 로봇탐지 차단 감지 (data.ipcheck !== true). 저장 위치: ${robotPath}`);
    console.error(`메시지:`, parsed.message);
    process.exit(1);
  }

  // 성공 응답 저장
  const responsePath = path.join(dataDir, "probe-response.json");
  writeFileSync(responsePath, JSON.stringify(parsed, null, 2), "utf8");
  console.log(`\n==================================================================`);
  console.log(`   [실측 성공! 전체 응답 저장: ${responsePath}]`);
  console.log(`==================================================================`);

  // 응답 요약 분석
  console.log(`\n1. 최상위 키 목록 :`, Object.keys(parsed));
  console.log(`2. data 객체 키 목록:`, Object.keys(data));

  const dmaResult = data.dma_result as Record<string, unknown> | undefined;
  if (!dmaResult) {
    console.warn(`[WARN] data.dma_result가 존재하지 않습니다! (data에 담긴 내용 확인 필요)`);
  } else {
    console.log(`\n3. data.dma_result 키 목록:`, Object.keys(dmaResult));

    // csBaseInfo 점검
    const csBaseInfo = dmaResult.csBaseInfo as Record<string, unknown> | undefined;
    if (csBaseInfo) {
      console.log(`\n4. csBaseInfo (사건 기본정보):`);
      console.log(`   - 법원코드 (cortOfcCd) :`, csBaseInfo.cortOfcCd);
      console.log(`   - 사건번호 (csNo)       :`, csBaseInfo.csNo);
      console.log(`   - 사건표시 (srnSaNo)    :`, csBaseInfo.srnSaNo);
      console.log(`   - 사건명 (csNm)         :`, csBaseInfo.csNm);
    } else {
      console.log(`\n4. csBaseInfo: 없음`);
    }

    // 사진 목록 점검
    const csPicLst = dmaResult.csPicLst;
    console.log(`\n5. 사진 목록 (csPicLst):`);
    if (!csPicLst) {
      console.log(`   - csPicLst 필드가 존재하지 않습니다.`);
    } else if (!Array.isArray(csPicLst)) {
      console.log(`   - csPicLst가 배열이 아닙니다:`, typeof csPicLst);
    } else {
      console.log(`   - 총 사진 장수: ${csPicLst.length}장`);
      csPicLst.forEach((pic: Record<string, unknown>, idx: number) => {
        const keys = Object.keys(pic);
        const picFile = pic.picFile ?? "";
        const len = typeof picFile === "string" ? picFile.length : 0;
        const prefix = typeof picFile === "string" ? picFile.slice(0, 30) : "";
        const isPng = prefix.startsWith("iVBORw0KGgo");
        const isDataUri = prefix.startsWith("data:image/");
        console.log(`   [사진 #${idx + 1}]`);
        console.log(`     - 키 목록     : ${keys.join(", ")}`);
        console.log(`     - 파일 크기   : ${len} 글자 (base64)`);
        console.log(`     - 시작 문자열 : "${prefix}..."`);
        console.log(`     - PNG 원본 여부: ${isPng ? "확인 (iVBORw0KGgo)" : isDataUri ? "data URI" : "기타/알수없음"}`);
        if (pic.seq) console.log(`     - seq         : ${pic.seq}`);
        if (pic.picDvsCd) console.log(`     - picDvsCd    : ${pic.picDvsCd}`);
      });
    }
  }
}

main().catch((err) => {
  console.error("[FATAL] 프로브 스크립트 실행 중 처리되지 않은 예외:", err);
  process.exit(1);
});
