/**
 * 계약 골든 생성 (add-spring-mysql-backend 6.1, D7).
 *
 * 원본 data/auctionboss.db를 export-seed.ts와 같은 가림 규칙(같은 함수, 같은 전체 이름 집합)으로 가린
 * 임시 SQLite에 복사하고, AUCTIONBOSS_DB를 그 파일로 지정한 뒤 기존 Next 라우트 핸들러(GET)를 직접 호출해
 * 응답(status + JSON body)을 backend/src/test/resources/contracts/{이름}.json 으로 저장한다.
 * Spring 계약 테스트(ContractTest)가 같은 요청을 보내 비교한다.
 *
 * 실행: npx tsx scripts/seed/generate-contracts.ts
 *
 * 별도 스크립트로 둔 이유: export-seed.ts는 "SQL 시드 내보내기" 한 가지 일을 하고 보고서(docs/untracked)를
 * 쓴다. 골든 생성은 라우트 핸들러 import, 요청 목록 관리, 결정성 검사까지 책임이 달라 한 파일에 섞으면
 * 길어진다. 가림 로직은 masking.ts를 그대로 import해 공유하므로 규칙이 갈라지지 않는다.
 *
 * 제외한 요청(시각 의존 — 원본 핸들러는 현재 시각을 주입할 수 없어 골든이 날짜에 따라 흔들린다):
 *  - excludePast=true : "오늘(한국 시간)" 이후 기일만 남기므로 실행 날짜에 결과가 달라진다.
 *  - needsAnalysis=true : 재분석 쿨다운이 현재 시각 기준이다.
 *  둘 다 5장의 고정 Clock 단위 테스트가 검증한다. (파라미터 검증만 하는 400 사례는 시각과 무관해 포함한다.)
 *
 * 보고서·출력에는 이름을 적지 않는다. 이름 점검은 개수만 출력한다.
 */
import Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { extractPersonNames, maskNames } from "./masking";

const ROOT = path.resolve(__dirname, "../..");
const SOURCE_DB = path.join(ROOT, "data/auctionboss.db");
const OUT_DIR = path.join(ROOT, "backend/src/test/resources/contracts");

interface Spec {
  name: string;
  path: string;
  /** 이미 퍼센트 인코딩된 쿼리 문자열(앞의 ? 제외). */
  query: string;
}

const enc = encodeURIComponent;

function buildSpecs(total: number): Spec[] {
  const specs: Spec[] = [];
  const list = (name: string, query: string) => specs.push({ name, path: "/api/items", query });

  list("list-default", "");
  list("list-page-size-5", "pageSize=5");

  for (const sort of ["auctionDate", "minBidPrice", "bidRatio", "failedBidCount", "pricePerArea"]) {
    for (const dir of ["asc", "desc"]) {
      list(`list-sort-${sort}-${dir}`, `sort=${sort}&dir=${dir}&pageSize=50`);
    }
  }
  // 정렬 키만, 방향만(기본값 조합)
  list("list-sort-only-bidRatio", "sort=bidRatio&pageSize=50");
  list("list-dir-only-desc", "dir=desc&pageSize=50");

  const lastPage = Math.ceil(total / 50);
  list("page-2", "page=2&pageSize=50");
  list("page-last", `page=${lastPage}&pageSize=50`);
  list("page-out-of-range", `page=${lastPage + 1}&pageSize=50`);
  list("page-max-size", "pageSize=200&sort=minBidPrice");

  list("filter-usage-single", `usage=${enc("오피스텔")}&pageSize=50`);
  list("filter-usage-compound-token", `usage=${enc("근린시설")}&pageSize=50`);
  list("filter-usage-multi", `usage=${enc("아파트")}&usage=${enc("대지")}&usage=${enc("임야")}&pageSize=50`);
  list("filter-price-range", "minPrice=100000000&maxPrice=300000000&pageSize=50");
  list("filter-price-min-only", "minPrice=1000000000&pageSize=50");
  list("filter-eok-man", "minEok=1&minMan=5000&maxEok=3&maxMan=0&pageSize=50");
  list("filter-eok-only-max", "maxEok=1&pageSize=50");
  list("filter-man-only-min", "minMan=30000&pageSize=50");
  list("filter-raw-beats-eok", "minPrice=200000000&minEok=5&maxEok=9&pageSize=50");
  list("filter-failed", "minFailed=3&pageSize=50");
  list("filter-discount", "minDiscountRate=30&pageSize=50");
  list("filter-sido-sigungu", `sido=${enc("서울특별시")}&sigungu=${enc("관악구")}&pageSize=50`);
  list("filter-sigungu-multi", `sigungu=${enc("서초구")}&sigungu=${enc("강남구")}&pageSize=50`);
  list("filter-sido-other", `sido=${enc("인천광역시")}&sido=${enc("전라남도")}`);
  list("filter-court", `court=${enc("서울중앙지방법원")}&pageSize=10`);
  list("filter-court-none", `court=${enc("부산지방법원")}`);
  list("filter-q-korean", `q=${enc("신림")}&pageSize=50`);
  list("filter-q-caseno-part", `q=${enc("타경18")}&pageSize=50`);
  list("filter-q-percent", `q=${enc("%")}`);
  list("filter-q-underscore", `q=${enc("_")}`);
  list("filter-q-backslash", `q=${enc("\\")}`);
  list("filter-q-case-insensitive", `q=${enc("genesis")}`);
  list("filter-q-trimmed", `q=${enc("  신림  ")}&pageSize=10`);
  list("filter-date-range", "dateFrom=2026-09-20&dateTo=2026-10-05&pageSize=50");
  list("filter-date-from-only", "dateFrom=2026-10-10&pageSize=50");
  list("filter-date-to-only", "dateTo=2026-09-10&pageSize=50");
  list("filter-analyzed-true", "analyzed=true");
  list("filter-analyzed-false", "analyzed=false&pageSize=20");
  list("filter-bookmarked-false", "bookmarked=false&pageSize=20");
  list("filter-bookmarked-true", "bookmarked=true");
  list("filter-has-photos-false", "hasPhotos=false&pageSize=20");
  list("filter-has-photos-true", "hasPhotos=true");
  list(
    "filter-combined",
    `usage=${enc("다세대")}&usage=${enc("연립주택")}&sido=${enc("서울특별시")}&minPrice=100000000&maxPrice=600000000&minFailed=1&sort=bidRatio&dir=desc&pageSize=50`,
  );
  list("filter-combined-pricePerArea", `sigungu=${enc("관악구")}&minDiscountRate=20&sort=pricePerArea&dir=asc&pageSize=50`);
  list("filter-empty-result", `usage=${enc("없는용도")}`);

  for (const [name, query] of [
    ["sort-invalid", "sort=nope"],
    ["dir-invalid", "dir=sideways"],
    ["page-size-zero", "pageSize=0"],
    ["page-size-too-large", "pageSize=201"],
    ["page-zero", "page=0"],
    ["page-not-number", "page=abc"],
    ["page-negative", "page=-1"],
    ["price-inverted", "minPrice=500&maxPrice=100"],
    ["eok-inverted", "minEok=3&maxEok=1"],
    ["analyzed-empty", "analyzed="],
    ["analyzed-invalid", "analyzed=maybe"],
    ["date-format", "dateFrom=2026/09/01"],
    ["date-inverted", "dateFrom=2026-10-01&dateTo=2026-09-01"],
    ["needs-analysis-without-prompt-version", "needsAnalysis=true"],
    ["needs-analysis-false", "needsAnalysis=false"],
    ["exclude-past-false", "excludePast=false"],
    ["discount-over-100", "minDiscountRate=101"],
    ["bookmarked-invalid", "bookmarked=yes"],
    ["multiple-errors", "page=abc&pageSize=999&sort=nope"],
    ["usage-empty", "usage="],
  ] as const) {
    list(`error-400-${name}`, query);
  }

  const detail = (name: string, p: string) => specs.push({ name, path: p, query: "" });
  for (const id of [1, 28, 53, 109]) detail(`detail-with-analysis-${id}`, `/api/items/${id}`);
  detail("detail-without-analysis-207", "/api/items/207");
  detail("detail-without-analysis-891", "/api/items/891");
  for (const id of [1, 3, 10]) detail(`changes-many-${id}`, `/api/items/${id}/changes`);
  for (const id of [2, 4]) detail(`changes-few-${id}`, `/api/items/${id}/changes`);
  detail("usage-types", "/api/items/usage-types");
  detail("error-404-detail-nan", "/api/items/abc");
  detail("error-404-detail-missing", "/api/items/999999");
  detail("error-404-detail-negative", "/api/items/-1");
  detail("error-404-changes-nan", "/api/items/abc/changes");
  detail("error-404-changes-missing", "/api/items/999999/changes");
  return specs;
}

/** export-seed.ts와 같은 순서·같은 함수로 이름 집합을 만든다. */
function personNames(db: Database.Database): string[] {
  const names = new Set<string>();
  const rows = db.prepare("SELECT note FROM items ORDER BY id").all() as { note: string | null }[];
  for (const r of rows) if (typeof r.note === "string") for (const n of extractPersonNames(r.note)) names.add(n);
  return [...names];
}

async function main(): Promise<void> {
  const work = mkdtempSync(path.join(tmpdir(), "auctionboss-contracts-"));
  const maskedDb = path.join(work, "masked.db");
  try {
    // 1) 원본의 일관된 스냅샷(WAL 포함)을 복사하고 note/body만 가린다.
    const src = new Database(SOURCE_DB, { readonly: true });
    const nameList = personNames(src);
    src.prepare("VACUUM INTO ?").run(maskedDb);
    src.close();

    const masked = new Database(maskedDb);
    const upd = masked.prepare("UPDATE items SET note = ? WHERE id = ?");
    for (const r of masked.prepare("SELECT id, note FROM items ORDER BY id").all() as { id: number; note: string | null }[]) {
      if (typeof r.note === "string") upd.run(maskNames(r.note, nameList), r.id);
    }
    const updBody = masked.prepare("UPDATE analyses SET body = ? WHERE id = ?");
    for (const r of masked.prepare("SELECT id, body FROM analyses ORDER BY id").all() as { id: number; body: string | null }[]) {
      if (typeof r.body === "string") updBody.run(maskNames(r.body, nameList), r.id);
    }
    const total = (masked.prepare("SELECT COUNT(*) AS c FROM items").get() as { c: number }).c;
    masked.close();

    // 2) 핸들러 호출. DB 경로는 import/호출 전에 지정한다.
    process.env.AUCTIONBOSS_DB = maskedDb;
    const { GET: listGet } = await import("../../src/app/api/items/route");
    const { GET: detailGet } = await import("../../src/app/api/items/[id]/route");
    const { GET: changesGet } = await import("../../src/app/api/items/[id]/changes/route");
    const { GET: usageGet } = await import("../../src/app/api/items/usage-types/route");
    const { closeDb } = await import("../../src/lib/db");

    const specs = buildSpecs(total);
    mkdirSync(OUT_DIR, { recursive: true });
    for (const f of readdirSync(OUT_DIR)) if (f.endsWith(".json")) rmSync(path.join(OUT_DIR, f));

    const origError = console.error;
    for (const spec of specs) {
      const url = `http://localhost${spec.path}${spec.query ? `?${spec.query}` : ""}`;
      const req = new Request(url);
      const m = /^\/api\/items\/([^/]+)(\/changes)?$/.exec(spec.path);
      console.error = () => undefined; // 500 로그가 섞이지 않게(500은 아래에서 실패 처리)
      let res: Response;
      if (spec.path === "/api/items") res = listGet(req);
      else if (spec.path === "/api/items/usage-types") res = usageGet();
      else if (m && m[2]) res = await changesGet(req, { params: Promise.resolve({ id: m[1] }) });
      else if (m) res = await detailGet(req, { params: Promise.resolve({ id: m[1] }) });
      else throw new Error(`알 수 없는 경로: ${spec.path}`);
      console.error = origError;
      if (res.status >= 500) throw new Error(`${spec.name}: 원본이 ${res.status}을 반환했다`);
      const body = (await res.json()) as unknown;
      const golden = { request: { path: spec.path, query: spec.query }, status: res.status, body };
      writeFileSync(path.join(OUT_DIR, `${spec.name}.json`), `${JSON.stringify(golden, null, 2)}\n`);
    }
    closeDb();

    // 3) 이름 점검: 개수만 출력한다.
    const combined = readdirSync(OUT_DIR)
      .filter((f) => f.endsWith(".json"))
      .map((f) => readFileSync(path.join(OUT_DIR, f), "utf8"))
      .join("\n");
    let occurrences = 0;
    for (const n of nameList) occurrences += combined.split(n).length - 1;
    console.log(`골든 ${specs.length}개 작성: ${path.relative(ROOT, OUT_DIR)}`);
    console.log(`가림 대상 이름 ${nameList.length}개, 골든 안 출현 ${occurrences}회`);
    if (occurrences !== 0) process.exitCode = 1;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
