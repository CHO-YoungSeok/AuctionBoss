/**
 * 소스 수집 실패 분류 (spec "수집 실패 처리", design.md D6).
 *
 * 전부 소스 중립적인 이름이다 — 스케줄러가 `SourceBlockedError`만 보고 백오프를
 * 걸 수 있어야 하고, 그러려면 워커가 courtauction 전용 타입을 import하면 안 된다.
 *
 * 계층:
 *   SourceError
 *     ├ SourceRequestError    네트워크 오류 / HTTP 비정상 상태
 *     ├ ResponseSchemaError   응답 형식 변경 (JSON 파싱 실패 · zod 검증 실패)
 *     └ SourceBlockedError    소스가 우리를 차단함 → 재시도 무의미, 장시간 백오프
 *         ├ WafBlockedError      WAF가 JSON 대신 HTML 차단 페이지를 반환 (HTTP 200)
 *         └ RobotDetectedError   로봇탐지 IP 차단 (`data.ipcheck === false`, HTTP 200)
 */

export class SourceError extends Error {
  override readonly name: string = "SourceError";
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}

/** 네트워크 실패 또는 HTTP 상태 코드 이상. */
export class SourceRequestError extends SourceError {
  override readonly name = "SourceRequestError";
  constructor(
    message: string,
    readonly detail: { url: string; status?: number },
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

/**
 * 응답이 기대한 스키마와 다르다. 조용히 넘기면 안 되는 "형식 변경 감지" 경로.
 * `issues`에는 zod가 알려준 경로/메시지를 사람이 읽을 수 있는 형태로 담는다.
 */
export class ResponseSchemaError extends SourceError {
  override readonly name = "ResponseSchemaError";
  constructor(
    message: string,
    readonly issues: string[],
    options?: { cause?: unknown },
  ) {
    super(issues.length > 0 ? `${message}\n${issues.map((i) => `  - ${i}`).join("\n")}` : message, options);
  }
}

/**
 * 소스가 우리 접근을 막았다. 같은 회차에서 재시도하거나 쿠키를 새로 받아도 풀리지
 * 않으므로(NOTES §6.1), 스케줄러는 이 오류를 보면 장시간 백오프에 들어가야 한다.
 */
export class SourceBlockedError extends SourceError {
  override readonly name: string = "SourceBlockedError";
}

/** WAF HTML 차단 페이지. HTTP는 200이고 본문만 HTML이라 상태 코드로는 감지 불가. */
export class WafBlockedError extends SourceBlockedError {
  override readonly name = "WafBlockedError";
  constructor(
    message: string,
    readonly bodyPreview: string,
  ) {
    super(message);
  }
}

/** 로봇탐지 IP 차단. HTTP 200 + `data.ipcheck === false`. */
export class RobotDetectedError extends SourceBlockedError {
  override readonly name = "RobotDetectedError";
  constructor(
    message: string,
    /** 소스가 준 안내 메시지(있으면). 예: "해당 IP는 비정상적인 접속으로 ..." */
    readonly sourceMessage: string | null,
  ) {
    super(message);
  }
}
