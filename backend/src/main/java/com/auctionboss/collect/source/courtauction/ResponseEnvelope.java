package com.auctionboss.collect.source.courtauction;

import com.auctionboss.collect.source.ResponseSchemaException;
import com.auctionboss.collect.source.RobotDetectedException;
import com.auctionboss.collect.source.WafBlockedException;
import java.util.List;

import tools.jackson.core.JacksonException;
import tools.jackson.databind.DeserializationFeature;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/**
 * 응답 본문 3단 검사의 앞 두 단(검색·상세 공통). 순서가 중요하다. HTTP 상태는 차단 상황에서도 200이라 판정에 쓸 수 없다.
 *
 * <ol>
 * <li>본문이 {@code {}로 시작하지 않으면 WAF HTML 차단 페이지</li>
 * <li>{@code data}가 객체가 아니면 형식 오류. 차단으로 오판하면 1시간 백오프에 잘못 들어가기 때문에 차단 판정보다 먼저 본다</li>
 * <li>{@code data.ipcheck}가 {@code true}가 아니면 로봇탐지 차단</li>
 * </ol>
 *
 * 세 번째 단(필드 형식 검증)은 {@link SearchResponseParser}·{@link DetailResponseParser}가 한다.
 */
final class ResponseEnvelope {

	static final JsonMapper JSON = JsonMapper.builder().enable(DeserializationFeature.FAIL_ON_TRAILING_TOKENS).build();

	private ResponseEnvelope() {
	}

	/** 앞 두 단을 통과한 {@code data} 객체를 돌려준다. */
	static JsonNode openData(String raw, String jsonFailMessage) {
		String trimmed = JsValues.trimStart(raw);
		if (!trimmed.startsWith("{")) {
			throw new WafBlockedException("WAF가 JSON 대신 차단 페이지를 반환했습니다 (HTTP 200이지만 본문이 JSON이 아님)",
					preview(trimmed));
		}

		JsonNode parsed;
		try {
			parsed = JSON.readTree(trimmed);
		}
		catch (JacksonException cause) {
			throw new ResponseSchemaException(jsonFailMessage, List.of(preview(trimmed)), cause);
		}

		JsonNode data = parsed.get("data");
		if (data == null || !(data.isObject() || data.isArray())) {
			throw new ResponseSchemaException("응답에 data 객체가 없습니다",
					List.of("data = " + (data == null ? "undefined" : data.toString())));
		}

		JsonNode ipcheck = data.isObject() ? data.get("ipcheck") : null;
		if (ipcheck == null || !ipcheck.isBoolean() || !ipcheck.booleanValue()) {
			JsonNode message = parsed.get("message");
			throw new RobotDetectedException(
					"로봇탐지에 걸려 차단됐습니다 (data.ipcheck !== true) — 재시도는 무의미하니 장시간 백오프가 필요합니다",
					message != null && message.isString() ? message.asString() : null);
		}
		return data;
	}

	private static String preview(String s) {
		return s.length() <= 200 ? s : s.substring(0, 200);
	}

}
