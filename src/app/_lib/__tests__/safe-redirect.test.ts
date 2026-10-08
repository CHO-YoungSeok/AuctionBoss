import { describe, expect, it } from "vitest";

import { isSafeRelativePath, resolveSafeReturnTo, SAFE_REDIRECT_FALLBACK } from "../safe-redirect";

describe("isSafeRelativePath", () => {
  it.each(["/", "/items/53", "/?q=%EC%8B%A0%EB%A6%BC&sort=bidRatio", "/feed?page=2", "/items/1#analysis"])(
    "같은 오리진의 상대 경로는 허용한다: %s",
    (path) => {
      expect(isSafeRelativePath(path)).toBe(true);
    },
  );

  // 회귀 방지: 예전 검사("/"로 시작하고 "//"가 아님)는 아래 값 중 백슬래시·제어 문자 사례를
  // 통과시켰고, URL 해석기는 이를 외부 오리진(evil.example)으로 풀었다.
  it.each([
    "https://evil.example",
    "//evil.example",
    "/\\evil.example",
    "/\\/evil.example",
    "/\t/evil.example",
    "/\n/evil.example",
    "/\r\n/evil.example",
    "\\\\evil.example",
    "evil.example",
    "",
    "javascript:alert(1)",
  ])("외부 오리진으로 풀릴 수 있는 값은 거부한다: %j", (path) => {
    expect(isSafeRelativePath(path)).toBe(false);
  });
});

describe("resolveSafeReturnTo", () => {
  it("안전하지 않거나 없으면 기본 경로로 돌아간다", () => {
    expect(resolveSafeReturnTo("/\\evil.example")).toBe(SAFE_REDIRECT_FALLBACK);
    expect(resolveSafeReturnTo(undefined)).toBe(SAFE_REDIRECT_FALLBACK);
    expect(resolveSafeReturnTo("/items/53")).toBe("/items/53");
  });
});
