package com.auctionboss.worker;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import com.auctionboss.common.body.BodyValidator;
import com.auctionboss.common.body.JsonBody;
import com.auctionboss.common.json.JsNumbers;
import tools.jackson.databind.JsonNode;

/**
 * 회차 시작·종료 본문 검증(원본 zod 스키마와 같은 규칙).
 *
 * <p>
 * {@code detail}은 zod 유니온처럼 수집 형식 -> 분석 형식 순으로 맞춰 보고, 처음 맞는 형식에 정의된 필드만 남긴 맵을 만든다.
 * 둘 다 안 맞으면 {@code detail} 이슈 하나({@code Invalid input})다. 사진 형식은 원본 PATCH도 받지 않으므로 받지 않는다. 정수 값인
 * 실수({@code 3.0})는 정수로 정규화해 저장한다.
 */
final class WorkerRunBodies {

	static final String INVALID_START = "잘못된 회차 시작 본문입니다";

	static final String INVALID_FINISH = "잘못된 회차 종료 본문입니다";

	private static final List<String> FINISH_OUTCOMES = List.of("success", "failed", "blocked");

	private static final List<String> COLLECTOR_NUMBERS = List.of("pagesRequested", "itemsFetched", "inserted",
			"updated", "changed");

	private static final List<String> ANALYZER_NUMBERS = List.of("newCount", "reanalysisCount", "succeeded", "failed");

	/** 검증을 마친 종료 요청. 선택 값은 없으면 null. */
	record FinishRequest(String outcome, String errorKind, String errorMessage, Map<String, Object> detail) {

		/** 집계용 변경 건수는 수집 형식 {@code detail}의 {@code changed}에서만 정해진다. */
		Number itemsChanged() {
			return detail != null && detail.get("changed") instanceof Number n ? n : null;
		}

	}

	private WorkerRunBodies() {
	}

	static String parseStart(byte[] raw) {
		BodyValidator v = BodyValidator.of(JsonBody.parse(raw));
		String worker = v.enumValue("worker", WorkerKind.ALL);
		v.throwIfInvalid(INVALID_START);
		return worker;
	}

	static FinishRequest parseFinish(byte[] raw) {
		BodyValidator v = BodyValidator.of(JsonBody.parse(raw));
		String outcome = v.enumValue("outcome", FINISH_OUTCOMES);
		String errorKind = v.string("errorKind", false, true, "String must contain at least 1 character(s)");
		String errorMessage = v.string("errorMessage", false, true, "String must contain at least 1 character(s)");
		Map<String, Object> detail = null;
		JsonNode node = v.get("detail");
		if (node != null && !node.isNull()) {
			detail = collector(node);
			if (detail == null) {
				detail = analyzer(node);
			}
			if (detail == null) {
				v.addIssue("detail", "Invalid input");
			}
		}
		v.throwIfInvalid(INVALID_FINISH);
		return new FinishRequest(outcome, errorKind, errorMessage, detail);
	}

	private static Map<String, Object> collector(JsonNode node) {
		if (!node.isObject()) {
			return null;
		}
		Map<String, Object> out = new LinkedHashMap<>();
		JsonNode courts = node.get("targetCourts");
		if (courts == null || !courts.isArray()) {
			return null;
		}
		List<String> names = new ArrayList<>();
		for (JsonNode c : courts) {
			if (!c.isString()) {
				return null;
			}
			names.add(c.stringValue());
		}
		out.put("targetCourts", names);
		return numbers(node, COLLECTOR_NUMBERS, out);
	}

	private static Map<String, Object> analyzer(JsonNode node) {
		if (!node.isObject()) {
			return null;
		}
		return numbers(node, ANALYZER_NUMBERS, new LinkedHashMap<>());
	}

	private static Map<String, Object> numbers(JsonNode node, List<String> keys, Map<String, Object> out) {
		for (String key : keys) {
			JsonNode n = node.get(key);
			if (n == null || !n.isNumber()) {
				return null;
			}
			out.put(key, n.isIntegralNumber() && n.canConvertToLong() ? (Object) n.longValue()
					: JsNumbers.normalize(n.doubleValue()));
		}
		return out;
	}

}
