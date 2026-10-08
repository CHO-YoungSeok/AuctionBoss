/**
 * 골든 포함 검사의 재료(`loadGoldenShapes`) 자체의 테스트(switch-web-to-data-port 회귀 검증).
 *
 * port-contract.test.ts의 "골든 포함 검사"는 이 함수가 돌려주는 집합에 기대므로, 집합이 너무 넓어지면
 * (예: 400·404 골든까지 담으면) 검사가 조용히 통과해 버린다. 여기서 그 의미를 고정한다.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadGoldenShapes } from "./golden-shapes";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "auctionboss-golden-shapes-"));
  mkdirSync(path.join(dir, "scenarios"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function write(rel: string, value: unknown): void {
  writeFileSync(path.join(dir, rel), JSON.stringify(value));
}

describe("loadGoldenShapes", () => {
  it("성공(2xx) 골든의 요청 틀만 담고 400·404·500 골든은 담지 않는다", () => {
    write("ok.json", { status: 200, request: { path: "/api/items/7", query: "" } });
    write("bad.json", { status: 400, request: { path: "/api/feed", query: "pageSize=201" } });
    write("missing.json", { status: 404, request: { path: "/api/items/999999/changes" } });
    write("boom.json", { status: 500, request: { path: "/api/boom" } });
    write("scenarios/s.json", {
      steps: [
        { status: 201, request: { method: "POST", path: "/api/bookmarks/3" } },
        { status: 404, request: { method: "POST", path: "/api/bookmarks/999999" } },
      ],
    });
    const keys = loadGoldenShapes(dir);
    expect([...keys].sort()).toEqual(["GET /api/items/{id}", "POST /api/bookmarks/{id}"]);
  });

  it("쿼리는 값이 아니라 키 집합(정렬·중복 제거)으로 구분한다", () => {
    write("a.json", { status: 200, request: { path: "/api/items", query: "sort=x&page=2&sort=y" } });
    write("b.json", { status: 200, request: { path: "/api/items" } });
    expect([...loadGoldenShapes(dir)].sort()).toEqual(["GET /api/items", "GET /api/items?page&sort"]);
  });
});
