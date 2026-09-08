/**
 * 분석 본문(`analyses.body`)을 서식이 있는 형태로 표시하기 위한 순수 파서
 * (live-data-and-reports task 4.1~4.3, design.md D3, spec "분석 결과 표시").
 *
 * ## 왜 라이브러리를 쓰지 않는가 (task 4.2)
 *
 * 실제 보고서 28건(`/tmp/ab-live.db`의 analyses 전부)을 세어 본 결과:
 *
 * | 구문 | 등장 횟수 | 등장 파일 수 |
 * |---|---|---|
 * | 굵게 `**...**` | 126 | 25/28 (89%) |
 * | 인라인 코드 `` `...` `` | 14 | 6/28 (21%) |
 * | 제목(`#`) | 0 | 0/28 |
 * | 목록(`-`/`*`/`1.`) | 0 | 0/28 |
 * | 표(`|...|`) | 0 | 0/28 |
 * | 기울임(단독 `*...*`) | 0 | 0/28 |
 *
 * 실제로 쓰이는 구문은 굵게와 인라인 코드 둘뿐이고, 나머지(제목·목록·표)는 프롬프트가
 * 요구하지도 않고 실제로도 전혀 나오지 않는다. 문단 구분(빈 줄)까지 합쳐도 3가지
 * 규칙으로 전부 처리된다 — 이 정도 구문 수는 `react-markdown` 같은 라이브러리를 새
 * 의존성으로 들이는 것보다, 이 파일 하나의 정규식 파서로 처리하는 편이 이 프로젝트의
 * "의존성 최소" 방침(CLAUDE.md)에 맞는다. 나중에 프롬프트가 바뀌어 목록·표가 실제로
 * 나오기 시작하면 그때 재평가한다.
 *
 * ## XSS 안전성 (task 4.3, spec MUST)
 *
 * 분석 본문은 외부 LLM이 생성한 통제되지 않는 텍스트다. 이 파서는 입력에서 **오직**
 * `**...**`(굵게)와 `` `...` ``(인라인 코드)만 구조로 인식하고, 그 외 모든 문자열
 * (HTML 태그처럼 보이는 것 포함, 예: `<script>`)은 항상 `type: "text"` 토큰의 `value`로
 * 문자열 그대로 보존한다. HTML로 파싱·해석하는 지점이 아예 없다 — `<`/`>`에 특별한 의미를
 * 주는 규칙 자체가 없다. 렌더링 쪽(`analysis-body.tsx`)도 `dangerouslySetInnerHTML`을
 * 쓰지 않고 이 토큰을 그대로 JSX 자식(문자열)으로 넘기므로, React가 항상 텍스트로
 * 이스케이프해서 그린다 — "sanitize를 잘 했는지" 검증이 필요한 게 아니라 애초에 HTML
 * 해석 경로가 없어서 실행될 수 없는 구조다.
 */

export type AnalysisInline =
  | { type: "text"; value: string }
  | { type: "bold"; value: string }
  | { type: "code"; value: string };

export type AnalysisParagraph = AnalysisInline[];

// `**굵게**` 또는 `` `코드` ``만 구조로 인식한다. 둘 다 내용이 비어 있으면(`****`, ` `` `)
// 매치하지 않는다 — 빈 강조는 실제 데이터에 없었고, 매치시키면 사용자가 실수로 입력한
// `**`(예: 수학 거듭제곱 표기)까지 삼킬 위험이 있다.
const INLINE_PATTERN = /\*\*([^*]+)\*\*|`([^`]+)`/g;

/**
 * 본문 한 줄(문단 내 한 줄)을 굵게/코드/일반 텍스트 토큰으로 나눈다. 매치되지 않는
 * 구간은 전부 `text` 토큰이 된다 — `<script>`처럼 보이는 문자열도 예외 없이 여기로
 * 들어간다(위 XSS 안전성 설명 참고).
 */
function parseLine(line: string): AnalysisInline[] {
  const tokens: AnalysisInline[] = [];
  let lastIndex = 0;

  for (const match of line.matchAll(INLINE_PATTERN)) {
    const index = match.index ?? 0;
    if (index > lastIndex) {
      tokens.push({ type: "text", value: line.slice(lastIndex, index) });
    }
    if (match[1] !== undefined) {
      tokens.push({ type: "bold", value: match[1] });
    } else if (match[2] !== undefined) {
      tokens.push({ type: "code", value: match[2] });
    }
    lastIndex = index + match[0].length;
  }

  if (lastIndex < line.length) {
    tokens.push({ type: "text", value: line.slice(lastIndex) });
  }

  return tokens;
}

/**
 * 분석 본문 전체를 문단(빈 줄로 구분) 단위로 나누고, 각 문단을 다시 줄 단위 토큰으로
 * 파싱한다. 문단 안의 단일 줄바꿈은 같은 문단의 값으로 유지하기 위해 `text` 토큰의
 * value에 `\n`을 그대로 남긴다 — 렌더링 쪽이 `<br/>`로 바꿀지, 공백으로 접을지를
 * 결정한다(이 파서는 표시 방식을 정하지 않는다).
 *
 * 앞뒤 공백만 있는 문단(연속 빈 줄이 여러 번인 경우 등)은 버린다 — 빈 `<p>`를 만들지
 * 않기 위함이다.
 */
export function parseAnalysisBody(body: string): AnalysisParagraph[] {
  const rawParagraphs = body.split(/\n{2,}/);
  const paragraphs: AnalysisParagraph[] = [];

  for (const raw of rawParagraphs) {
    if (raw.trim().length === 0) continue;
    paragraphs.push(parseLine(raw));
  }

  return paragraphs;
}
