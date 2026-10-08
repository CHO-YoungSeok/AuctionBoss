package com.auctionboss.analysis;

import com.auctionboss.common.body.BodyValidator;
import com.auctionboss.common.body.JsonBody;

/** {@code POST /api/analyses} 본문 검증. 원본 zod 스키마와 같은 필드 순서·규칙이다. */
final class AnalysisBodyParser {

	static final String INVALID = "잘못된 분석 결과 본문입니다";

	private AnalysisBodyParser() {
	}

	static NewAnalysis parse(byte[] raw) {
		BodyValidator v = BodyValidator.of(JsonBody.parse(raw));
		Double itemId = v.positiveInteger("itemId", "itemId는 정수여야 합니다", "itemId는 1 이상이어야 합니다");
		String body = v.string("body", true, false, "body는 비어 있을 수 없습니다");
		String promptVersion = v.string("promptVersion", true, false, "promptVersion은 비어 있을 수 없습니다");
		String model = v.string("model", false, false, "model은 비어 있을 수 없습니다");
		v.throwIfInvalid(INVALID);
		return new NewAnalysis(itemId, body, promptVersion, model);
	}

}
