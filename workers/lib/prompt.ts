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

/**
 * 저장되는 `prompt_version` 값. 템플릿 내용을 바꾸면 이 값과
 * `workers/prompts/analyze-item.md`의 `prompt_version` 주석을 함께 올린다 (design.md D5).
 */
export const PROMPT_VERSION = "v2";

/** 템플릿에서 물건 JSON이 들어갈 자리. 철자를 바꾸면 템플릿도 같이 고쳐야 한다. */
export const ITEM_JSON_TOKEN = "{{ITEM_JSON}}";

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

  return raw;
}

/** 물건 1건을 템플릿에 끼워 넣은 최종 프롬프트를 만든다. */
export function renderItemPrompt(template: string, item: AuctionItem): string {
  return template.split(ITEM_JSON_TOKEN).join(JSON.stringify(item, null, 2));
}
