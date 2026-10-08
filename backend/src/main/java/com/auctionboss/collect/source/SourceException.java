package com.auctionboss.collect.source;

/**
 * 소스 수집 실패 분류의 뿌리. 계층(TS {@code errors.ts}와 같다):
 *
 * <pre>
 * SourceException
 *   ├ SourceRequestException    네트워크 오류 / HTTP 비정상 상태 / 외부 요청 불허
 *   ├ ResponseSchemaException   응답 형식 변경(JSON 해석 실패, 형식 검증 실패)
 *   └ SourceBlockedException    소스가 차단함 → 장시간 백오프
 *       ├ WafBlockedException      WAF가 JSON 대신 HTML 차단 페이지를 반환
 *       └ RobotDetectedException   로봇탐지 IP 차단
 * </pre>
 *
 * {@link #kind()}는 {@code worker_runs.error_kind}에 그대로 기록되는 TS 오류 클래스 이름이다.
 * {@link #requestsMade()}는 이 오류가 나기까지 실제로 보낸 요청(페이지) 수다. 어댑터가 오류를 다시 던질 때 채운다
 * ({@link #attachRequestsMade}). 채워지지 않았으면 0이다(요청을 한 번도 보내기 전에 실패한 경우).
 */
public abstract class SourceException extends RuntimeException {

	private int requestsMade;

	protected SourceException(String message, Throwable cause) {
		super(message, cause);
	}

	/** TS 오류 이름. 예: {@code SourceRequestError}. */
	public abstract String kind();

	public int requestsMade() {
		return requestsMade;
	}

	/**
	 * 실패 직전까지 실제로 보낸 요청 수를 오류에 더한다(TS {@code attachPagesRequested}). 더 안쪽 호출이 이미 채운 값이 있으면
	 * 더한다: 여러 법원을 돌다 하나가 실패하면 앞서 끝낸 법원들의 요청 수와 그 법원에서 실패 전까지 보낸 수를 합쳐야 한다.
	 */
	public static <E extends Throwable> E attachRequestsMade(E error, int requests) {
		if (error instanceof SourceException source) {
			source.requestsMade += requests;
		}
		return error;
	}

}
