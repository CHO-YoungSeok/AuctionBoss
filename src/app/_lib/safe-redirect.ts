/**
 * 폼 제출 후 돌아갈 경로 검증(add-bookmarks-and-feed task 4.1, design.md D5).
 *
 * 목록/상세의 관심 토글 폼은 `returnTo` 필드로 "지금 보던 화면"을 들고 다닌다 — 서버가
 * 그 값을 그대로 리다이렉트 대상으로 쓰기 전에, 같은 오리진의 상대 경로인지 반드시
 * 확인해야 한다. 그렇지 않으면 사용자가 조작한 폼(또는 악성 페이지가 자동 제출하는 폼)이
 * `returnTo=https://evil.example`처럼 외부로 리다이렉트시키는 오픈 리다이렉트가 된다.
 *
 * 순수 함수로 뽑은 이유: 이 판단이 라우트 핸들러 안에 인라인돼 있으면 검증 규칙이
 * 조용히 느슨해져도(예: `//evil.com`처럼 프로토콜 상대 경로를 놓치는 경우) 테스트가
 * 잡아내지 못한다.
 */

/** `"/"`로 시작하되 `"//"`(프로토콜 상대 경로, 브라우저가 외부 오리진으로 해석)는 아닌
 * 경로만 안전하다고 본다. */
export function isSafeRelativePath(path: string): boolean {
  return path.startsWith("/") && !path.startsWith("//");
}

/** 검증에 실패하면 이 기본 경로로 돌아간다 — 물건 목록(홈)이 가장 안전한 폴백이다. */
export const SAFE_REDIRECT_FALLBACK = "/";

/** `returnTo` 값을 검증해 안전한 상대 경로만 통과시킨다. 없거나 안전하지 않으면 기본값. */
export function resolveSafeReturnTo(returnTo: string | null | undefined): string {
  if (returnTo && isSafeRelativePath(returnTo)) return returnTo;
  return SAFE_REDIRECT_FALLBACK;
}
