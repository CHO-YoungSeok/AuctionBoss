/**
 * 개발 검증용 루프백 가짜 소스 서버 (port-collector-to-spring D13, tasks 8.1·8.3 dry-run).
 *
 * 127.0.0.1에만 바인딩하고, 어댑터가 부르는 경로 셋을 어댑터 골든의 픽스처(가림 처리본)로 계속 응답한다(순서 재생이 아니라
 * 경로별 정적 응답이라 회차가 몇 번이든 같다). 외부 사이트에는 요청하지 않는다.
 *
 *   GET  /pgj/index.on                          세션 쿠키
 *   POST /pgj/pgjsearch/searchControllerMain.on  검색(픽스처 행 전부, 1페이지)
 *   POST /pgj/pgj15B/selectAuctnCsSrchRslt.on    상세(사진 2장)
 *   GET  /__stats                                { requests, maxConcurrent, hosts, remotes, byPath }  (검증용)
 *   GET  /__block?n=K                            다음 검색 요청 K건(기본 1)에 WAF 차단 페이지(HTTP 200, JSON 아님)로 답한다(롤백 리허설의 차단 백오프용)
 *   GET  /__pics                                 응답에 쓴 사진의 { seq, sha256, bytes } (파일 API 바이트 비교용)
 *
 * 실행: npx tsx scripts/dev/fake-source-server.ts --port-file <경로> [--port N] [--slow-ms N] [--log <jsonl 경로>]
 *   --port: 고정 포트(기본 0 = 임의). 리허설 사이드카처럼 소비자가 주소를 미리 알아야 할 때만 쓴다. 바인딩은 항상 127.0.0.1.
 *   --slow-ms: 검색 응답을 N ms 늦춘다(회차를 주기보다 길게 만들어 overlap을 일으키는 용도).
 *   --log: 요청마다 { t, method, path, host, remote } 한 줄을 이어 쓴다(본문·쿠키는 쓰지 않는다).
 * 준비되면 포트를 --port-file에 쓴다.
 */
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";

// 입력은 동결된 소스 어댑터 골든의 픽스처(이미 가림 처리됨)다. TS 어댑터는 은퇴했다(migrate-data-and-cutover 8.4).
const FIXTURES_DIR = path.resolve(__dirname, "../../backend/src/test/resources/contracts/source/fixtures");
type Json = Record<string, unknown>;
const readFixture = <T>(name: string): T => JSON.parse(readFileSync(path.join(FIXTURES_DIR, name), "utf8")) as T;

/** 검색 응답 봉투(소스가 HTTP 200으로 내는 모양). */
function validBody(options: { rows: Json[] }): string {
  const rows = options.rows;
  return JSON.stringify({
    status: 200,
    message: "검색 결과가 조회되었습니다.",
    timestamp: 1788675327824,
    errors: null,
    token: null,
    data: {
      dma_pageInfo: {
        pageNo: 1,
        pageSize: 100,
        bfPageNo: 1,
        startRowNo: 1,
        totalCnt: String(rows.length),
        totalYn: "Y",
        groupTotalCount: rows.length,
      },
      ipcheck: true,
      dlt_srchResult: rows,
    },
  });
}

/** 상세 응답 봉투. */
function validDetailBody(options: { baseInfo: Json; pics: Json[] }): string {
  return JSON.stringify({
    status: 200,
    message: "물건상세검색 정보가  조회되었습니다.",
    timestamp: 1789087532321,
    errors: null,
    token: null,
    data: { dma_result: { csBaseInfo: options.baseInfo, csPicLst: options.pics }, ipcheck: true },
  });
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const portFile = arg("port-file");
const slowMs = Number(arg("slow-ms") ?? "0");
const logFile = arg("log");
const fixedPort = Number(arg("port") ?? "0");
if (!portFile) {
  console.error("--port-file이 필요합니다");
  process.exit(2);
}

const fx = {
  searchRows: readFixture<{ realRow: Json; bundleRows: Json[]; roadOnlyRow: Json }>("search-rows.json"),
  detailResponse: readFixture<{ baseInfo: Json; pics: Json[] }>("detail-response.json"),
};
const searchBody = validBody({ rows: [fx.searchRows.realRow, ...fx.searchRows.bundleRows, fx.searchRows.roadOnlyRow] });
const detailBody = validDetailBody({ baseInfo: fx.detailResponse.baseInfo, pics: fx.detailResponse.pics });
const COOKIES = ["JSESSIONID=fake-session; Path=/; HttpOnly", "WMONID=fake-wmon; Path=/"];

const pics = fx.detailResponse.pics.map((p, i) => {
  const bytes = Buffer.from(String(p.picFile ?? ""), "base64");
  return { seq: Number(p.cortAuctnPicSeq ?? i + 1), sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length };
});

let blockNext = 0;
let inFlight = 0;
let maxConcurrent = 0;
let requests = 0;
const hosts: Record<string, number> = {};
const remotes: Record<string, number> = {};
const byPath: Record<string, number> = {};

const server = http.createServer((req, res) => {
  const path = req.url ?? "";
  if (path === "/__stats") {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ requests, maxConcurrent, hosts, remotes, byPath }));
    return;
  }
  if (path.startsWith("/__block")) {
    blockNext = Math.max(0, Math.trunc(Number(new URL(path, "http://x").searchParams.get("n") ?? "1")) || 1);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ blockNext }));
    return;
  }
  if (path === "/__pics") {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(pics));
    return;
  }
  inFlight += 1;
  maxConcurrent = Math.max(maxConcurrent, inFlight);
  requests += 1;
  const host = String(req.headers.host ?? "");
  const remote = req.socket.remoteAddress ?? "";
  hosts[host] = (hosts[host] ?? 0) + 1;
  remotes[remote] = (remotes[remote] ?? 0) + 1;
  byPath[path] = (byPath[path] ?? 0) + 1;
  if (logFile) {
    appendFileSync(logFile, JSON.stringify({ t: new Date().toISOString(), method: req.method, path, host, remote }) + "\n");
  }
  req.resume();
  req.on("end", () => {
    const finish = (status: number, body: string, cookies?: string[]) => {
      res.statusCode = status;
      if (cookies) res.setHeader("set-cookie", cookies);
      res.setHeader("content-type", "application/json;charset=UTF-8");
      res.end(body);
      inFlight -= 1;
    };
    if (req.method === "GET" && path === "/pgj/index.on") finish(200, "<html><body>index</body></html>", COOKIES);
    else if (req.method === "POST" && path === "/pgj/pgjsearch/searchControllerMain.on") {
      if (blockNext > 0) {
        blockNext -= 1;
        finish(200, "<html><body>blocked by fake WAF</body></html>");
        return;
      }
      setTimeout(() => finish(200, searchBody), slowMs);
    } else if (req.method === "POST" && path === "/pgj/pgj15B/selectAuctnCsSrchRslt.on") finish(200, detailBody);
    else finish(404, "not found");
  });
});

server.listen(fixedPort, "127.0.0.1", () => {
  writeFileSync(portFile, String((server.address() as AddressInfo).port));
});
for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    server.closeAllConnections();
    server.close(() => process.exit(0));
  });
}
