/**
 * 분석 프롬프트 템플릿 로딩·렌더링.
 *
 * 치환은 일부러 "단순 문자열 교체" 하나로만 한다. 템플릿 엔진을 쓰면 물건 데이터에
 * 우연히 들어 있는 문자열이 템플릿 문법으로 해석될 수 있고, 분석 결과가 조용히
 * 달라지는 원인을 추적하기 어려워진다.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import type { AuctionItem } from "@/lib/domain";

import { computeDerivedFigures, type RoundFigure } from "./derived";

/**
 * 저장되는 `prompt_version` 값. 템플릿 내용을 바꾸면 이 값과
 * `workers/prompts/analyze-item.md`의 `prompt_version` 주석을 함께 올린다 (design.md D5).
 *
 * v2 → v3: 실데이터 검증에서 v2가 면적당 가격·차수별 저감 추이를 "정보 없음"으로
 * 잘못 답한 사례가 나왔다(값이 전부 non-null이고 프롬프트에도 들어 있었는데도). 원인은
 * 모델에게 JSON에서 필드를 찾아 null 체크 후 나눗셈까지 시킨 것 — v3는 그 산수를
 * `./derived.ts`가 코드로 미리 끝내고, 프롬프트에는 "파생 지표" 블록으로 계산된 값만
 * 명시해 모델은 해석만 하게 한다. 프롬프트 입력 자체가 바뀌었으므로 버전을 올린다.
 */
export const PROMPT_VERSION = "v3";

/** 템플릿에서 물건 JSON이 들어갈 자리. 철자를 바꾸면 템플릿도 같이 고쳐야 한다. */
export const ITEM_JSON_TOKEN = "{{ITEM_JSON}}";

/** 템플릿에서 코드로 미리 계산한 파생 지표 블록이 들어갈 자리. */
export const DERIVED_FIGURES_TOKEN = "{{DERIVED_FIGURES}}";

/** 템플릿 기본 경로. 저장소 루트 기준. */
export const DEFAULT_PROMPT_PATH = "workers/prompts/analyze-item.md";

/** 템플릿을 읽지 못했거나 형식이 어긋날 때 던지는 오류. */
export class PromptTemplateError extends Error {
  override readonly name = "PromptTemplateError";
  constructor(
    message: string,
    readonly promptPath: string,
    options?: { cause?: unknown },
  ) {
    super(`${message} (${promptPath})`, options);
  }
}

/** env `AUCTIONBOSS_ANALYZE_PROMPT` > 인자 > 기본 경로. */
export function resolvePromptPath(explicitPath?: string): string {
  if (explicitPath) return path.resolve(explicitPath);
  const fromEnv = process.env.AUCTIONBOSS_ANALYZE_PROMPT;
  if (fromEnv) return path.resolve(fromEnv);
  return path.resolve(process.cwd(), DEFAULT_PROMPT_PATH);
}

/**
 * 템플릿 파일을 읽는다. 치환 토큰이 없으면 즉시 throw한다 —
 * 토큰 없는 템플릿은 물건 데이터 없이 Claude를 호출하게 되고, 그 결과가 그럴듯한
 * 텍스트라서 조용한 실패가 되기 때문이다.
 */
export function loadPromptTemplate(explicitPath?: string): string {
  const resolved = resolvePromptPath(explicitPath);

  let raw: string;
  try {
    raw = readFileSync(resolved, "utf8");
  } catch (cause) {
    throw new PromptTemplateError("분석 프롬프트 템플릿을 읽을 수 없습니다", resolved, { cause });
  }

  if (!raw.includes(ITEM_JSON_TOKEN)) {
    throw new PromptTemplateError(
      `분석 프롬프트 템플릿에 ${ITEM_JSON_TOKEN} 토큰이 없습니다`,
      resolved,
    );
  }
  if (!raw.includes(DERIVED_FIGURES_TOKEN)) {
    throw new PromptTemplateError(
      `분석 프롬프트 템플릿에 ${DERIVED_FIGURES_TOKEN} 토큰이 없습니다`,
      resolved,
    );
  }

  return raw;
}

const wonFormatter = new Intl.NumberFormat("ko-KR");

/** 원 단위 정수를 천 단위 구분 기호와 함께 표시한다. `Math.round`로 반올림한다. */
function formatWonPlain(value: number): string {
  return `${wonFormatter.format(Math.round(value))}원`;
}

/** 회차 하나를 "1차: 711,000,000원 (감정가 대비 100.0%, 직전 회차 대비 20.0% 저감)" 형태로 만든다. */
function formatRoundFigureLine(round: RoundFigure): string {
  const parts: string[] = [];
  if (round.ratioToAppraisalPercent !== null) {
    parts.push(`감정가 대비 ${round.ratioToAppraisalPercent}%`);
  }
  if (round.stepDownFromPreviousPercent !== null) {
    parts.push(`직전 회차 대비 ${round.stepDownFromPreviousPercent}% 저감`);
  }
  const suffix = parts.length > 0 ? ` (${parts.join(", ")})` : "";
  return `  - ${round.round}차: ${formatWonPlain(round.price)}${suffix}`;
}

/**
 * `computeDerivedFigures`의 결과를 프롬프트에 그대로 박아 넣을 텍스트 블록으로 만든다.
 * "계산됨"은 숫자를 명시하고, "계산 불가"는 이유를 그대로 적어 모델이 새로 계산하거나
 * 값을 지어내지 못하게 한다.
 */
function renderDerivedFiguresBlock(item: AuctionItem): string {
  const { pricePerArea, roundTrend } = computeDerivedFigures(item);

  const pricePerAreaLine = pricePerArea.computed
    ? `- 면적당 최저매각가격: ${formatWonPlain(pricePerArea.wonPerArea)}/㎡`
    : `- 면적당 최저매각가격: 계산 불가 — ${pricePerArea.reason}`;

  const roundTrendLines = roundTrend.computed
    ? [`- 차수별 최저가 추이:`, ...roundTrend.rounds.map(formatRoundFigureLine)]
    : [`- 차수별 최저가 추이: 계산 불가 — ${roundTrend.reason}`];

  return [pricePerAreaLine, ...roundTrendLines].join("\n");
}

/**
 * 물건 1건을 템플릿에 끼워 넣은 최종 프롬프트를 만든다. 물건 JSON 자리와 함께, 코드로
 * 미리 계산한 파생 지표 블록 자리도 채운다(D5, v3) — 모델이 직접 산수·null 판정을
 * 하지 않도록 계산은 여기서 끝낸다.
 */
export function renderItemPrompt(template: string, item: AuctionItem): string {
  return template
    .split(DERIVED_FIGURES_TOKEN)
    .join(renderDerivedFiguresBlock(item))
    .split(ITEM_JSON_TOKEN)
    .join(JSON.stringify(item, null, 2));
}
