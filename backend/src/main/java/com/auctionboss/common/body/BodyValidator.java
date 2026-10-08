package com.auctionboss.common.body;

import java.util.ArrayList;
import java.util.List;

import com.auctionboss.common.error.FieldIssue;
import com.auctionboss.common.error.InvalidRequestException;
import tools.jackson.databind.JsonNode;

/**
 * zod 스키마와 같은 규칙으로 객체 본문을 검사한다.
 *
 * <ul>
 * <li>본문이 객체가 아니면 {@code (root)} 이슈 하나뿐이다.</li>
 * <li>타입을 바꿔 받아들이지 않는다({@code "1"}은 숫자가 아니다). 모르는 키는 읽지 않는다.</li>
 * <li>이슈는 호출한 필드 순서대로 쌓인다(zod는 스키마의 필드 순서로 모은다). 키가 없으면 {@code Required}다.</li>
 * </ul>
 * 메시지 문구는 zod 3의 기본 문구를 따른다(원본 {@code details[].message}).
 */
public final class BodyValidator {

	public static final String ROOT = "(root)";

	private final JsonNode object;

	private final List<FieldIssue> issues = new ArrayList<>();

	private BodyValidator(JsonNode root) {
		if (root.isObject()) {
			this.object = root;
		}
		else {
			this.object = null;
			issues.add(new FieldIssue(ROOT, "Expected object, received " + typeName(root)));
		}
	}

	public static BodyValidator of(JsonNode root) {
		return new BodyValidator(root);
	}

	public boolean hasIssues() {
		return !issues.isEmpty();
	}

	public List<FieldIssue> issues() {
		return List.copyOf(issues);
	}

	/** 이슈가 있으면 400 예외를 던진다. */
	public void throwIfInvalid(String message) {
		if (!issues.isEmpty()) {
			throw new InvalidRequestException(message, issues);
		}
	}

	/** zod의 received 표기. */
	public static String typeName(JsonNode node) {
		if (node == null) {
			return "undefined";
		}
		if (node.isNull()) {
			return "null";
		}
		if (node.isArray()) {
			return "array";
		}
		if (node.isObject()) {
			return "object";
		}
		if (node.isString()) {
			return "string";
		}
		if (node.isBoolean()) {
			return "boolean";
		}
		return "number";
	}

	/** 키가 없으면 null(JS의 undefined). 값이 JSON null이면 NullNode. */
	public JsonNode get(String field) {
		return object == null ? null : object.get(field);
	}

	/**
	 * 1 이상의 정수 필수 필드({@code z.number().int(..).positive(..)}). 정수 검사와 양수 검사는 둘 다 실패할 수 있고
	 * 그러면 이슈가 둘이다. 유효하지 않으면 null.
	 */
	public Double positiveInteger(String field, String integerMessage, String positiveMessage) {
		if (object == null) {
			return null;
		}
		JsonNode node = object.get(field);
		if (node == null) {
			issues.add(new FieldIssue(field, "Required"));
			return null;
		}
		if (!node.isNumber()) {
			issues.add(new FieldIssue(field, "Expected number, received " + typeName(node)));
			return null;
		}
		double d = node.doubleValue();
		boolean ok = true;
		if (!(d == Math.rint(d) && !Double.isInfinite(d))) {
			issues.add(new FieldIssue(field, integerMessage));
			ok = false;
		}
		if (!(d > 0)) {
			issues.add(new FieldIssue(field, positiveMessage));
			ok = false;
		}
		return ok ? d : null;
	}

	/**
	 * 문자열 필드({@code z.string().min(1, ..)}).
	 *
	 * @param required 키가 없으면 {@code Required}
	 * @param nullable JSON null을 허용(없는 것과 같게 null을 돌려준다)
	 * @param emptyMessage 빈 문자열 이슈의 메시지
	 */
	public String string(String field, boolean required, boolean nullable, String emptyMessage) {
		if (object == null) {
			return null;
		}
		JsonNode node = object.get(field);
		if (node == null) {
			if (required) {
				issues.add(new FieldIssue(field, "Required"));
			}
			return null;
		}
		if (node.isNull() && nullable) {
			return null;
		}
		if (!node.isString()) {
			issues.add(new FieldIssue(field, "Expected string, received " + typeName(node)));
			return null;
		}
		String value = node.stringValue();
		if (value.isEmpty()) {
			issues.add(new FieldIssue(field, emptyMessage));
			return null;
		}
		return value;
	}

	/** 필수 열거형 문자열({@code z.enum([...])}). */
	public String enumValue(String field, List<String> allowed) {
		if (object == null) {
			return null;
		}
		JsonNode node = object.get(field);
		String expected = "'" + String.join("' | '", allowed) + "'";
		if (node == null) {
			issues.add(new FieldIssue(field, "Required"));
			return null;
		}
		if (!node.isString()) {
			issues.add(new FieldIssue(field, "Expected " + expected + ", received " + typeName(node)));
			return null;
		}
		String value = node.stringValue();
		if (!allowed.contains(value)) {
			issues.add(new FieldIssue(field,
					"Invalid enum value. Expected " + expected + ", received '" + value + "'"));
			return null;
		}
		return value;
	}

	/** 직접 검사하는 필드에 이슈를 더한다. */
	public void addIssue(String field, String message) {
		issues.add(new FieldIssue(field, message));
	}

}
