/**
 * `analysis-body.ts`/`.tsx` 테스트(live-data-and-reports task 4.1~4.3).
 *
 * 두 계층을 나눠 검증한다:
 * 1. 파서(`parseAnalysisBody`) — 순수 함수라 토큰 구조를 직접 비교한다.
 * 2. 렌더링(`AnalysisBody`) — `react-dom/server`의 `renderToStaticMarkup`으로 실제 HTML
 *    문자열을 뽑아, XSS 페이로드가 **이스케이프된 텍스트**로만 나오고 실제 태그로
 *    나오지 않는지 확인한다(spec MUST: "본문에 포함된 마크업이 페이지에서 실행되어서는
 *    안 된다"). 이 프로젝트에는 jsdom/@testing-library/react가 없어 DOM 렌더링 테스트가
 *    없었는데, `renderToStaticMarkup`은 서버 렌더링 함수라 DOM 없이(`environment: "node"`)
 *    그대로 쓸 수 있어 새 테스트 의존성을 추가하지 않는다.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AnalysisBody } from "../analysis-body";
import { parseAnalysisBody } from "../analysis-body-parse";

describe("parseAnalysisBody", () => {
  it("굵게(**...**)를 bold 토큰으로 판정한다", () => {
    expect(parseAnalysisBody("**요약** 텍스트")).toEqual([
      [
        { type: "bold", value: "요약" },
        { type: "text", value: " 텍스트" },
      ],
    ]);
  });

  it("인라인 코드(`...`)를 code 토큰으로 판정한다", () => {
    expect(parseAnalysisBody("`status`는 유찰 1회")).toEqual([
      [
        { type: "code", value: "status" },
        { type: "text", value: "는 유찰 1회" },
      ],
    ]);
  });

  it("빈 줄 2개 이상을 문단 구분으로 본다", () => {
    const result = parseAnalysisBody("첫 문단입니다.\n\n둘째 문단입니다.");
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual([{ type: "text", value: "첫 문단입니다." }]);
    expect(result[1]).toEqual([{ type: "text", value: "둘째 문단입니다." }]);
  });

  it("빈 문단(연속 빈 줄)은 버린다", () => {
    const result = parseAnalysisBody("문단1\n\n\n\n문단2");
    expect(result).toHaveLength(2);
  });

  it("실제 보고서와 같은 형태(굵게 라벨 + 대시 + 본문)를 처리한다", () => {
    const body =
      "**요약 평가** — 서울 성북구 정릉동 소재 아파트로, 1회 유찰된 상태다.\n\n" +
      "**감정가 대비 최저매각가격 비율** — 100.0%로, `failedBidCount`는 1이다.";
    const result = parseAnalysisBody(body);
    expect(result).toHaveLength(2);
    expect(result[0]?.[0]).toEqual({ type: "bold", value: "요약 평가" });
    expect(result[1]).toContainEqual({ type: "bold", value: "감정가 대비 최저매각가격 비율" });
    expect(result[1]).toContainEqual({ type: "code", value: "failedBidCount" });
  });

  it("닫히지 않은 **는 굵게로 판정하지 않고 텍스트 그대로 둔다", () => {
    const result = parseAnalysisBody("가격이 2**3 만큼 늘었다");
    expect(result).toEqual([[{ type: "text", value: "가격이 2**3 만큼 늘었다" }]]);
  });

  it("빈 본문은 빈 배열을 돌려준다", () => {
    expect(parseAnalysisBody("")).toEqual([]);
    expect(parseAnalysisBody("   \n\n   ")).toEqual([]);
  });

  it("HTML 태그처럼 보이는 문자열도 구조로 해석하지 않고 text 토큰 그대로 둔다", () => {
    const body = "특이사항: <script>alert(1)</script> 이 값은 무시해야 한다.";
    const result = parseAnalysisBody(body);
    expect(result).toEqual([[{ type: "text", value: body }]]);
  });
});

describe("AnalysisBody 렌더링 — XSS 안전성 (spec MUST)", () => {
  it("<script> 태그가 실제 태그가 아니라 이스케이프된 텍스트로 렌더된다", () => {
    const body = "특이사항 — <script>alert('xss')</script> 이 값은 위험 신호다.";
    const html = renderToStaticMarkup(createElement(AnalysisBody, { body }));

    // 실행 가능한 <script> 태그가 출력물에 그대로 존재해서는 안 된다.
    expect(html).not.toContain("<script>alert");
    // React가 이스케이프한 형태(&lt;script&gt;)로 텍스트가 보존돼야 한다 — 내용이
    // 통째로 사라지면(silent drop) 그것도 잘못이다. 사용자가 원문을 볼 수 있어야 한다.
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("alert(&#x27;xss&#x27;)");
  });

  it("onerror 이벤트 핸들러가 담긴 img 태그도 속성으로 실행되지 않고 텍스트로 나온다", () => {
    const body = '위험한 입력: <img src=x onerror=alert(1)> 확인 필요.';
    const html = renderToStaticMarkup(createElement(AnalysisBody, { body }));

    // 실제 <img ... onerror=...> 요소가 만들어지면 안 된다.
    expect(html).not.toMatch(/<img[^>]*onerror/i);
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });

  it("굵게·코드와 XSS 페이로드가 섞여 있어도 굵게/코드만 태그가 되고 나머지는 텍스트다", () => {
    const body = "**결론** — 위험: <script>evil()</script>, 필드: `status`";
    const html = renderToStaticMarkup(createElement(AnalysisBody, { body }));

    expect(html).toContain("<strong>결론</strong>");
    expect(html).toContain("<code>status</code>");
    expect(html).not.toContain("<script>evil");
    expect(html).toContain("&lt;script&gt;evil()&lt;/script&gt;");
  });

  it("정상적인 굵게 텍스트는 <strong> 태그로 렌더된다", () => {
    const html = renderToStaticMarkup(createElement(AnalysisBody, { body: "**80.0%**로 하락" }));
    expect(html).toContain("<strong>80.0%</strong>");
  });

  it("여러 문단이 각각 <p>로 분리된다", () => {
    const html = renderToStaticMarkup(
      createElement(AnalysisBody, { body: "첫 문단.\n\n둘째 문단." }),
    );
    const paragraphCount = (html.match(/<p>/g) ?? []).length;
    expect(paragraphCount).toBe(2);
  });
});
