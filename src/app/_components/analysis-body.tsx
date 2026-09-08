/**
 * 분석 본문 렌더링 컴포넌트(live-data-and-reports task 4.1~4.3, design.md D3).
 *
 * 파싱은 전부 `analysis-body.ts`의 순수 함수(`parseAnalysisBody`)가 하고, 이 컴포넌트는
 * 그 결과(문단 → 굵게/코드/텍스트 토큰)를 JSX로 옮기기만 한다. `dangerouslySetInnerHTML`을
 * 쓰지 않는다 — 토큰의 `value`는 항상 JSX 자식(문자열)으로만 들어가므로 React가 텍스트로
 * 이스케이프한다. 이 컴포넌트가 HTML 문자열을 만들거나 해석하는 지점이 없다는 것 자체가
 * spec의 "본문에 포함된 마크업이 페이지에서 실행되어서는 안 된다(MUST NOT)"를 만족시키는
 * 근거다(`analysis-body.ts` 상단 주석 참고).
 *
 * 문단 내부의 단일 줄바꿈은 `<br/>`로 표시한다 — 원문 서식(파서가 보존한 `\n`)이 화면에서
 * 사라지지 않게 하기 위함이다.
 */
import { Fragment } from "react";

import { parseAnalysisBody, type AnalysisInline } from "./analysis-body";

function renderInline(token: AnalysisInline, key: number) {
  if (token.type === "bold") return <strong key={key}>{token.value}</strong>;
  if (token.type === "code") return <code key={key}>{token.value}</code>;

  // text 토큰: 줄바꿈만 <br/>로 바꾸고 나머지는 그대로 문자열 자식으로 둔다. `<script>`
  // 같은 문자열이 여기 들어와도 React가 텍스트로 렌더링한다 — 마크업으로 해석되지 않는다.
  const lines = token.value.split("\n");
  return (
    <Fragment key={key}>
      {lines.map((line, i) => (
        <Fragment key={i}>
          {i > 0 ? <br /> : null}
          {line}
        </Fragment>
      ))}
    </Fragment>
  );
}

export function AnalysisBody({ body, className }: { body: string; className?: string }) {
  const paragraphs = parseAnalysisBody(body);

  return (
    <div className={className}>
      {paragraphs.map((paragraph, pIndex) => (
        <p key={pIndex}>
          {paragraph.map((token, tIndex) => renderInline(token, tIndex))}
        </p>
      ))}
    </div>
  );
}
