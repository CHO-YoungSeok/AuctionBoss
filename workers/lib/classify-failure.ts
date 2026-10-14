/**
 * 물건 단위 분석 실패의 원인 분류.
 *
 * - "item": 그 물건 때문에 실패했다(거절, max_tokens, 빈/잘못된 출력, 타임아웃, 저장 4xx).
 *   → 쿨다운에 넣고 다음 물건으로 계속한다.
 * - "systemic": 환경 때문에 실패했다(백엔드 다운/5xx, 인증·권한·한도·과부하, CLI 실행 불가).
 *   → 쿨다운에 넣지 않는다(물건 탓이 아님). 이번 회차의 남은 물건도 같은 이유로 실패하고
 *   유료 호출만 낭비하므로 회차를 중단한다.
 *
 * 규칙(HTTP 상태, 서버 저장 API와 Anthropic API 공통):
 *   401/403/429/5xx, 상태 없음(네트워크 오류) → systemic
 *   그 밖의 4xx(400/404/409/413/422 등) → item
 * 타임아웃은 item이다 — 지나치게 큰 입력 한 건이 원인일 수 있고, 시스템 장애라면 곧
 * 다른 물건이 연결 오류·5xx로 실패해 그때 systemic으로 중단된다.
 * 분류할 수 없는 오류는 item이다(회차 전체를 멈추는 쪽이 더 비싼 오판이다).
 */
import Anthropic from "@anthropic-ai/sdk";

import { AnalyzerApiError } from "./api";
import { ClaudeInvocationError } from "./claude";

export type FailureKind = "item" | "systemic";

function classifyStatus(status: number | undefined): FailureKind {
  if (status === undefined) return "systemic";
  if (status === 401 || status === 403 || status === 429 || status >= 500) return "systemic";
  return "item";
}

/**
 * CLI가 낸 진단 문구(stderr, is_error 봉투의 result)와 Anthropic API 오류 message 중
 * 환경 문제를 가리키는 것. 숫자 상태는 "status 401"/"API Error: 529"처럼 문맥이 있을 때만
 * 본다("401호", "500만원" 같은 물건 내용 오인 방지). 모델 출력 텍스트에는 적용하지 않는다.
 */
const SYSTEMIC_DIAGNOSTIC =
  /invalid api key|authentication_error|permission_error|rate_limit_error|overloaded_error|api_error|unauthorized|permission denied|credit balance|rate.?limit|overloaded|quota|usage limit|hit your limit|limit reached|not logged in|please run \/login|\b(?:status|http|code|api error)[:=\s]*(?:401|403|429|5\d\d)\b/i;

/** 400으로 오는 결제·크레딧 소진 문구. */
const BILLING_MESSAGE = /credit balance|billing|purchase credits|plans\s*&\s*billing/i;

/** CLI 실행 파일을 띄울 수 없는 시스템 오류 코드. */
const SPAWN_FAILURE_CODES = new Set(["ENOENT", "EACCES", "EPERM", "ENOMEM", "EMFILE", "E2BIG"]);

function classifyOne(error: unknown): FailureKind | null {
  if (error instanceof AnalyzerApiError) return classifyStatus(error.status);
  if (error instanceof Anthropic.APIConnectionTimeoutError) return "item";
  if (error instanceof Anthropic.APIConnectionError) return "systemic";
  if (error instanceof Anthropic.APIError) {
    // 크레딧 소진은 HTTP 400 invalid_request_error로 온다 — 물건 탓이 아니다.
    if (error.status === 400 && BILLING_MESSAGE.test(error.message)) return "systemic";
    return classifyStatus(error.status);
  }
  if (error instanceof ClaudeInvocationError && typeof error.status === "number") {
    // 구조화된 상태(CLI 봉투의 api_error_status)는 문구 휴리스틱보다 우선한다.
    if (error.status === 400 && error.diagnostic && BILLING_MESSAGE.test(error.diagnostic)) return "systemic";
    return classifyStatus(error.status);
  }
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string" && SPAWN_FAILURE_CODES.has(code)) return "systemic";
  return null;
}

export function classifyFailure(error: unknown): FailureKind {
  // ClaudeInvocationError는 SDK/exec 오류를 cause로 감싸므로 원인 사슬을 따라 내려간다.
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== undefined && current !== null; depth += 1) {
    const kind = classifyOne(current);
    if (kind) return kind;
    current = (current as { cause?: unknown }).cause;
  }
  if (error instanceof ClaudeInvocationError && error.diagnostic && SYSTEMIC_DIAGNOSTIC.test(error.diagnostic)) {
    // CLI의 is_error 봉투(인증·한도 등)는 구조화된 상태가 없어 진단 문구로 판별한다.
    return "systemic";
  }
  return "item";
}
