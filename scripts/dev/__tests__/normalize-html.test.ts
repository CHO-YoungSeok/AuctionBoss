import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const script = join(__dirname, "..", "normalize-html.py");
const normalize = (html: string) => execFileSync("python3", [script], { input: html }).toString();
const push = (s: string) => `<script>self.__next_f.push([1,${JSON.stringify(s)}])</script>`;

describe("scripts/dev/normalize-html.py (compare-screens 정규화)", () => {
  it("스트리밍 조각 나누기·번호가 달라도 같은 내용이면 같다", () => {
    const dom = "<main>물건 목록</main>";
    const one = dom + push('4:["$","b",null,{"children":"가"}]\n5:["$","i",null,{"x":1}]\n');
    const split = dom + push('4:["$","b",null,{"children":"가"}]\n') + push('a:["$","i",null,{"x":1}]\n');
    expect(normalize(one)).toBe(normalize(split));
  });

  it("조각 안의 값이 다르면 다르다(값 차이를 숨기지 않는다)", () => {
    const a = "<main>x</main>" + push('4:["$","b",null,{"children":"가"}]\n');
    const b = "<main>x</main>" + push('4:["$","b",null,{"children":"나"}]\n');
    expect(normalize(a)).not.toBe(normalize(b));
  });

  it("보이는 DOM이 다르면 다르다", () => {
    expect(normalize("<main>1분 전</main>")).not.toBe(normalize("<main>2분 전</main>"));
  });

  it("빌드 ID 경로만 같게 만든다", () => {
    const h = (id: string) => `<link href="/_next/static/${id}/_buildManifest.js"/>`;
    expect(normalize(h("AbCdEfGhIjKlMnOp12345"))).toBe(normalize(h("ZyXwVuTsRqPoNmLk98765")));
  });
});
