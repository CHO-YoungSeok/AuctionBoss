package com.auctionboss.common.body;

import com.auctionboss.common.error.InvalidRequestException;
import tools.jackson.databind.DeserializationFeature;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/**
 * 쓰기 요청 본문을 JSON으로 해석한다. 원본의 {@code request.json()}과 같이 Content-Type을 보지 않는다.
 * JS {@code JSON.parse}처럼 뒤따르는 토큰이 있으면 실패로 본다.
 */
public final class JsonBody {

	public static final String UNPARSEABLE = "JSON 본문을 해석할 수 없습니다";

	private static final JsonMapper MAPPER = JsonMapper.builder().enable(DeserializationFeature.FAIL_ON_TRAILING_TOKENS)
			.build();

	private JsonBody() {
	}

	/** 해석에 실패하면 400({@code error}만, {@code details} 없음)이 되는 예외를 던진다. */
	public static JsonNode parse(byte[] raw) {
		if (raw == null || raw.length == 0) {
			throw unparseable();
		}
		JsonNode node;
		try {
			node = MAPPER.readTree(raw);
		}
		catch (RuntimeException e) {
			throw unparseable();
		}
		if (node == null || node.isMissingNode()) {
			throw unparseable();
		}
		return node;
	}

	private static InvalidRequestException unparseable() {
		return new InvalidRequestException(UNPARSEABLE, null);
	}

}
