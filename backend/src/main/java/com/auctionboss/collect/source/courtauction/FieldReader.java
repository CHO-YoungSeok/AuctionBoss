package com.auctionboss.collect.source.courtauction;

import java.util.List;

import tools.jackson.databind.JsonNode;

/**
 * 객체의 필드를 형식 검증 규칙(zod의 {@code string | null | undefined}, {@code string | number | null | undefined})대로 읽는다.
 * 어긋난 필드는 이슈로 모으고 값은 null로 둔다.
 */
final class FieldReader {

	private final JsonNode node;

	private final String path;

	private final List<String> issues;

	FieldReader(JsonNode node, String path, List<String> issues) {
		this.node = node;
		this.path = path;
		this.issues = issues;
	}

	String text(String name) {
		JsonNode value = node.get(name);
		if (value == null || value.isNull()) {
			return null;
		}
		if (value.isString()) {
			return value.asString();
		}
		issue(name, "string", value);
		return null;
	}

	Numericish numeric(String name) {
		JsonNode value = node.get(name);
		if (value == null || value.isNull()) {
			return null;
		}
		if (value.isString()) {
			return Numericish.ofText(value.asString());
		}
		if (value.isNumber()) {
			return Numericish.ofNumber(value.doubleValue());
		}
		issue(name, "string | number", value);
		return null;
	}

	private void issue(String name, String expected, JsonNode value) {
		issues.add(path + name + ": Invalid input: expected " + expected + ", received " + typeName(value));
	}

	static String typeName(JsonNode value) {
		if (value == null) {
			return "undefined";
		}
		if (value.isNull()) {
			return "null";
		}
		if (value.isString()) {
			return "string";
		}
		if (value.isNumber()) {
			return "number";
		}
		if (value.isBoolean()) {
			return "boolean";
		}
		return value.isArray() ? "array" : "object";
	}

}
