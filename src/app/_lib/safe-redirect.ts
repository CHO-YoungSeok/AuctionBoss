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

/** 같은 오리진인지 확인할 때 쓰는 가상의 기준 오리진. 실제로 요청하지 않는다. */
const PROBE_ORIGIN = "http://same-origin.invalid";

/**
 * 같은 오리진 안의 상대 경로만 안전하다고 본다.
 *
 * `"/"`로 시작하고 `"//"`(프로토콜 상대 경로)가 아니어야 한다는 문자열 검사만으로는 부족하다.
 * 브라우저와 URL 해석기는 백슬래시를 `/`로 바꾸고(`/\evil.example` → `//evil.example`),
 * 탭·줄바꿈을 지운 뒤 해석하기 때문에 문자열 검사를 통과한 값이 외부 오리진이 될 수 있다
 * (2026-10-09 3단계 계획 중 발견). 그래서 (1) 백슬래시와 제어 문자를 거부하고,
 * (2) 실제 URL 해석기로 풀어 본 결과가 기준 오리진에 그대로 머무는지까지 확인한다.
 */
export function isSafeRelativePath(path: string): boolean {
  if (!path.startsWith("/") || path.startsWith("//")) return false;
  if (/[\\\u0000-\u001f\u007f]/.test(path)) return false;
  try {
    return new URL(path, PROBE_ORIGIN).origin === PROBE_ORIGIN;
  } catch {
    return false;
  }
}

/** 검증에 실패하면 이 기본 경로로 돌아간다 — 물건 목록(홈)이 가장 안전한 폴백이다. */
export const SAFE_REDIRECT_FALLBACK = "/";

/** `returnTo` 값을 검증해 안전한 상대 경로만 통과시킨다. 없거나 안전하지 않으면 기본값. */
export function resolveSafeReturnTo(returnTo: string | null | undefined): string {
  if (returnTo && isSafeRelativePath(returnTo)) return returnTo;
  return SAFE_REDIRECT_FALLBACK;
}
