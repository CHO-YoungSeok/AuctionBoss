import { linkSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closeDb } from "../../../src/lib/db";
import { buildSyntheticSource } from "../fixtures/synthetic-source";
import {
  assertNotLiveSource,
  buildRequestList,
  CompareApiError,
  compareRequests,
  createHttpFetcher,
  createNextHandlerFetcher,
  diffJson,
  formatReport,
  type ApiFetcher,
} from "../compare-api";

const SENTINEL = "__REAL_NAME_SENTINEL__";
let work: string;
let dbPath: string;
let requests: ReturnType<typeof buildRequestList>;
let source: ApiFetcher;

beforeAll(() => {
  work = mkdtempSync(path.join(tmpdir(), "compare-api-"));
  dbPath = buildSyntheticSource(path.join(work, "src")).dbPath;
  requests = buildRequestList(dbPath);
  source = createNextHandlerFetcher(dbPath);
});
afterAll(() => {
  closeDb();
  rmSync(work, { recursive: true, force: true });
});

/** "같은 응답을 내는 가짜 Spring": 같은 핸들러를 같은 DB로 부른다. 응답 본문을 고치는 훅을 낄 수 있다. */
function fakeSpring(edit?: (pathAndQuery: string, body: unknown) => unknown): ApiFetcher {
  const same = createNextHandlerFetcher(dbPath);
  return async (p) => {
    const res = await same(p);
    return { status: res.status, body: edit ? edit(p, structuredClone(res.body)) : res.body };
  };
}

describe("요청 목록", () => {
  it("계약 골든 목록(시각 의존 제외)에 물건별 상세·변경·분석(limit=50)·사진을 더한다", () => {
    const names = requests.map((r) => r.name);
    expect(names).toContain("list-default");
    expect(requests.some((r) => r.pathAndQuery.includes("excludePast=true"))).toBe(false);
    // needsAnalysis=true는 파라미터 검증만 하는 400 사례(시각과 무관)만 남는다.
    expect(requests.filter((r) => r.pathAndQuery.includes("needsAnalysis=true")).map((r) => r.name)).toEqual(["error-400-needs-analysis-without-prompt-version"]);
    for (const id of [3, 7, 1200]) {
      expect(names).toEqual(expect.arrayContaining([`item-${id}-detail`, `item-${id}-changes`, `item-${id}-analyses`, `item-${id}-photos`]));
    }
    expect(requests.find((r) => r.name === "item-7-analyses")?.pathAndQuery).toBe("/api/items/7/analyses?limit=50");
  });
});

describe("비교", () => {
  it("같은 응답을 내는 가짜 Spring이면 불일치 0", async () => {
    const report = await compareRequests(requests, source, fakeSpring());
    expect(report.requests).toBe(requests.length);
    expect(report.mismatches).toBe(0);
  });

  it("한 필드를 바꾼 가짜는 불일치 1과 요청 이름·JSON 경로를 알리고 값은 출력에 없다", async () => {
    const edited = fakeSpring((p, body) => {
      if (p === "/api/items/3") (body as { item: { address: string } }).item.address = `${SENTINEL} changed`;
      return body;
    });
    const report = await compareRequests(requests, source, edited);
    expect(report.mismatches).toBe(1);
    expect(report.mismatched[0]).toMatchObject({ name: "item-3-detail", path: "$.item.address", reason: "value" });
    const text = formatReport(report);
    expect(text).toContain("item-3-detail $.item.address");
    expect(text).not.toContain(SENTINEL);
    expect(text).not.toContain("합성시");
  });

  it("배열 순서만 바꾼 가짜는 불일치(순서를 무시하지 않는다)", async () => {
    const swapped = fakeSpring((p, body) => {
      if (p === "/api/items/3/changes") {
        const b = body as { changes: unknown[] };
        b.changes.reverse();
      }
      return body;
    });
    const report = await compareRequests(requests, source, swapped);
    // 계약 목록(changes-many-3)과 물건별 목록(item-3-changes)이 같은 경로라 둘 다 걸린다.
    expect(report.mismatched.map((m) => m.name).sort()).toEqual(["changes-many-3", "item-3-changes"]);
  });

  it("상태 코드·키 누락·전송 실패도 불일치이고, 전송 오류 메시지의 값은 출력에 없다", async () => {
    const down: ApiFetcher = async () => {
      throw new Error(`connect failed ${SENTINEL}`);
    };
    const report = await compareRequests(requests.slice(0, 3), source, down);
    expect(report.mismatches).toBe(3);
    expect(report.mismatched.every((m) => m.reason === "transport")).toBe(true);
    expect(formatReport(report)).not.toContain(SENTINEL);

    const status404 = fakeSpring();
    const wrongStatus: ApiFetcher = async (p) => (p === "/api/items/7/photos" ? { status: 500, body: {} } : status404(p));
    const r2 = await compareRequests(requests, source, wrongStatus);
    expect(r2.mismatched).toEqual([{ name: "item-7-photos", path: "$", reason: "status" }]);
  });

  it("원본 쪽이 실패하면 값 없이 이름만 담아 던진다", async () => {
    const broken: ApiFetcher = async () => {
      throw new Error(SENTINEL);
    };
    await expect(compareRequests(requests.slice(0, 1), broken, fakeSpring())).rejects.toThrow(/원본 쪽 요청 실패: list-default$/);
  });
});

describe("diffJson", () => {
  it("객체 키 순서는 무시, 배열 순서는 비교, 숫자는 값, 키 누락과 초과를 구별한다", () => {
    expect(diffJson({ a: 1, b: [1, 2] }, { b: [1, 2], a: 1 })).toBeNull();
    expect(diffJson({ a: [1, 2] }, { a: [2, 1] })).toEqual({ path: "$.a[0]", reason: "number" });
    expect(diffJson({ a: 1 }, {})).toEqual({ path: "$.a", reason: "missing-key" });
    expect(diffJson({}, { a: 1 })).toEqual({ path: "$.a", reason: "extra-key" });
    expect(diffJson({ a: null }, { a: 0 })).toEqual({ path: "$.a", reason: "type" });
    expect(diffJson([1], [1, 2])).toEqual({ path: "$", reason: "array-length" });
    expect(diffJson({ a: 123456789012 }, { a: 123456789012 })).toBeNull();
  });
});

describe("원본 보호·HTTP 대상", () => {
  it("운영 원본 경로는 거부한다", () => {
    expect(() => assertNotLiveSource("data/auctionboss.db")).toThrow(CompareApiError);
    expect(() => assertNotLiveSource(path.join(work, "backup.db"))).not.toThrow();
  });

  it("심볼릭 링크·하드 링크로 운영 원본을 가리켜도 거부한다(경로 문자열 비교만으로는 뚫린다)", () => {
    const live = path.join(work, "live.db");
    writeFileSync(live, "x");
    const sym = path.join(work, "sym.db");
    const hard = path.join(work, "hard.db");
    symlinkSync(live, sym);
    linkSync(live, hard);
    const copy = path.join(work, "copy.db");
    writeFileSync(copy, "x");
    expect(() => assertNotLiveSource(sym, live)).toThrow(CompareApiError);
    expect(() => assertNotLiveSource(hard, live)).toThrow(CompareApiError);
    expect(() => assertNotLiveSource(copy, live)).not.toThrow();
  });

  it("HTTP 대상 fetcher는 JSON이 아닌 본문을 INVALID_JSON으로 다룬다", async () => {
    const fetcher = createHttpFetcher("http://spring.test/", (async (url: string) => {
      expect(url).toBe("http://spring.test/api/items");
      return new Response("<html>", { status: 502 });
    }) as unknown as typeof fetch);
    const res = await fetcher("/api/items");
    expect(res.status).toBe(502);
    expect(typeof res.body).toBe("symbol");
  });
});
