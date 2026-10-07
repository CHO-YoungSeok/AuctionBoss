/**
 * 시드 데이터용 개인 이름 가림 함수 (add-spring-mysql-backend D6).
 *
 * 순수 함수만 둔다. DB 접근 없이 문자열만 다룬다.
 * 흐름: extractPersonNames(비고) -> maskNames(비고/분석 본문, 이름들) -> findSuspiciousPhrases(결과 점검).
 */

export const MASK = "○○○";

/** 기관명 접미사. 후보가 이 중 하나로 끝나거나 포함하면 기관으로 보고 제외한다. */
const INSTITUTION_MARKERS = [
  "공사",
  "공단",
  "은행",
  "보험",
  "주식회사",
  "조합",
  "금고",
  "캐피탈",
  "저축은행",
  "협회",
  "재단",
  "법인",
  "(주)",
];

/** 이름이 아닌 일반어. */
const STOPWORDS = new Set([
  "및",
  "등",
  "임차인",
  "소유자",
  "채무자",
  "채권자",
  "신청채권자",
  "해당",
  "본건",
  "있음",
  "없음",
  "미상",
  "불명",
  "미신고",
  "전부",
  "다수",
  "일부",
]);

/** 이름 뒤에 붙을 수 있는 조사. */
const TRAILING_PARTICLES = ["은", "는", "이", "가", "의"];

/** `<이름>의 임차보증금` 문형. 앞이 한글이 아니어야 단어 전체가 잡힌다. 그룹 1이 단어 전체. */
const POSSESSIVE_PATTERN = /(?<![가-힣])([가-힣]{2,4})의 임차보증금/g;

/**
 * `임차인 <단어>` 같은 문형. 그룹 1은 키워드 뒤에 이어지는 **한글 단어 전체**다.
 * 단어 전체를 잡아야 `임차인 신한은행은`에서 `신한`만 떼어 이름으로 오인하지 않는다.
 */
const KEYWORD_PATTERNS: RegExp[] = [
  /임차인 ([가-힣]+)/g,
  /채무자 ([가-힣]+)/g,
  /소유자 ([가-힣]+)/g,
];

function isInstitution(word: string): boolean {
  return INSTITUTION_MARKERS.some((m) => word.includes(m));
}

function isPersonCandidate(word: string): boolean {
  return !isInstitution(word) && !STOPWORDS.has(word);
}

/**
 * 키워드 뒤 단어에서 이름을 꺼낸다. 기관 판정은 조사를 떼기 **전의 단어 전체**로 한다.
 * 조사는 단어가 4자 이상일 때만 뗀다 — 한국 이름은 대부분 3자라서 `김가은`(3자)을
 * `김가` + `은`으로 자르면 안 된다. 결과가 2~4자 한글이 아니면 이름으로 보지 않는다.
 */
function nameFromKeywordWord(word: string): string | null {
  if (isInstitution(word) || STOPWORDS.has(word)) return null;
  let name = word;
  if (word.length >= 4 && TRAILING_PARTICLES.includes(word.slice(-1))) {
    name = word.slice(0, -1);
  }
  if (name.length < 2 || name.length > 4) return null;
  return isPersonCandidate(name) ? name : null;
}

/** 비고에서 개인 이름 후보를 패턴으로 추출한다(중복 제거, 등장 순서 유지). */
export function extractPersonNames(note: string): string[] {
  const found = new Set<string>();
  for (const m of note.matchAll(POSSESSIVE_PATTERN)) {
    const word = m[1];
    if (word && isPersonCandidate(word)) found.add(word);
  }
  for (const pattern of KEYWORD_PATTERNS) {
    for (const m of note.matchAll(pattern)) {
      const name = m[1] ? nameFromKeywordWord(m[1]) : null;
      if (name) found.add(name);
    }
  }
  return [...found];
}

/** 각 이름 전체를 `○○○`로 치환한다(글자 수와 무관). 긴 이름부터 처리한다. */
export function maskNames(text: string, names: string[]): string {
  const sorted = [...new Set(names)]
    .filter((n) => n.length > 0)
    .sort((a, b) => b.length - a.length);
  let out = text;
  for (const name of sorted) out = out.split(name).join(MASK);
  return out;
}

/**
 * 가림 이후에도 남은 의심 문구 보고용.
 * `임차인 <한글>`, `<한글>의 임차` 중 기관/일반어/○○○가 아닌 것을 돌려준다.
 */
export function findSuspiciousPhrases(text: string): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(/임차인 ([가-힣]+)/g)) {
    const word = m[1];
    // 이름+조사(최대 5자)만 의심한다. 긴 단어는 일반 용어로 본다.
    if (word.length <= 5 && isPersonCandidate(word)) found.add(m[0]);
  }
  for (const m of text.matchAll(/(?<![가-힣])([가-힣]{2,4})의 임차/g)) {
    if (isPersonCandidate(m[1])) found.add(m[0]);
  }
  return [...found];
}
