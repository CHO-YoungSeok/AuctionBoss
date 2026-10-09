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
 *   GET  /__pics                                 응답에 쓴 사진의 { seq, sha256, bytes } (파일 API 바이트 비교용)
 *
 * 실행: npx tsx scripts/dev/fake-source-server.ts --port-file <경로> [--slow-ms N] [--log <jsonl 경로>]
 *   --slow-ms: 검색 응답을 N ms 늦춘다(회차를 주기보다 길게 만들어 overlap을 일으키는 용도).
 *   --log: 요청마다 { t, method, path, host, remote } 한 줄을 이어 쓴다(본문·쿠키는 쓰지 않는다).
 * 준비되면 포트를 --port-file에 쓴다.
 */
import { createHash } from "node:crypto";
import { appendFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";

import { buildFixtureSet } from "../collector-golden/fixtures";
import { validBody, validDetailBody } from "../../src/lib/sources/courtauction/__tests__/fixtures";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const portFile = arg("port-file");
const slowMs = Number(arg("slow-ms") ?? "0");
const logFile = arg("log");
if (!portFile) {
  console.error("--port-file이 필요합니다");
  process.exit(2);
}

const fx = buildFixtureSet();
const searchBody = validBody({ rows: [fx.searchRows.realRow, ...fx.searchRows.bundleRows, fx.searchRows.roadOnlyRow] });
const detailBody = validDetailBody({ baseInfo: fx.detailResponse.baseInfo, pics: fx.detailResponse.pics });
const COOKIES = ["JSESSIONID=fake-session; Path=/; HttpOnly", "WMONID=fake-wmon; Path=/"];

const pics = fx.detailResponse.pics.map((p, i) => {
  const bytes = Buffer.from(String(p.picFile ?? ""), "base64");
  return { seq: Number(p.cortAuctnPicSeq ?? i + 1), sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length };
});

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
      setTimeout(() => finish(200, searchBody), slowMs);
    } else if (req.method === "POST" && path === "/pgj/pgj15B/selectAuctnCsSrchRslt.on") finish(200, detailBody);
    else finish(404, "not found");
  });
});

server.listen(0, "127.0.0.1", () => {
  writeFileSync(portFile, String((server.address() as AddressInfo).port));
});
for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    server.closeAllConnections();
    server.close(() => process.exit(0));
  });
}
