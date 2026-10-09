package com.auctionboss.migration;

import java.math.BigDecimal;
import java.math.BigInteger;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;

/**
 * 행 정규화 규칙(migrate-data-and-cutover D4)의 Java 구현. TS {@code scripts/migrate/normalize.ts}의 규칙을 MySQL 값에서 독립적으로
 * 다시 구현한 것이다(같은 코드를 공유하지 않는다). 두 구현의 일치는 교차 언어 골든({@code src/test/resources/migration})으로 고정한다.
 *
 * <p>
 * 규칙(버전 {@link #RULE_VERSION}): 값은 NULL이면 {@code null}, 정수는 10진 문자열, 시각은 {@code YYYY-MM-DDTHH:mm:ss.SSSZ}(UTC),
 * 날짜는 {@code YYYY-MM-DD}, JSON은 파싱한 뒤 객체 키를 (UTF-16 코드 유닛 순으로) 재귀 정렬해 공백 없이 다시 쓴 문자열(숫자는 정수만,
 * 절댓값 2^53-1 이하), 그 밖 문자열은 그대로(trim·NFC 정규화 없음)다. 행은 컬럼 순서대로 모은 값을 공백 없는 JSON 배열 한 줄로 쓰고,
 * 문자열은 {@code "} {@code \} 와 제어 문자(U+0000~U+001F)만 이스케이프한다(비 ASCII 문자는 그대로).
 *
 * <p>
 * 오류 메시지에는 값을 넣지 않는다(D14).
 */
final class RowNormalizer {

	static final int RULE_VERSION = 1;

	/** 컬럼 종류. MySQL 컬럼 형식에서 정한다. */
	enum Kind {

		INT, TEXT, DATETIME, DATE, JSON

	}

	private static final DateTimeFormatter DATETIME = DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'");

	private static final BigInteger MAX_SAFE = BigInteger.valueOf(9_007_199_254_740_991L);

	private RowNormalizer() {
	}

	static String integer(long value) {
		return Long.toString(value);
	}

	static String datetime(LocalDateTime value) {
		return DATETIME.format(value);
	}

	static String date(LocalDate value) {
		return value.toString();
	}

	/** JSON 텍스트를 정규화한다. 규칙에 어긋나면 값 없는 {@link IllegalArgumentException}이다. */
	static String json(String text) {
		try {
			JsonParser parser = new JsonParser(text);
			Object value = parser.parseDocument();
			StringBuilder out = new StringBuilder();
			writeCanonical(value, out);
			return out.toString();
		}
		catch (IllegalArgumentException e) {
			throw new IllegalArgumentException("정규화할 수 없는 json 값입니다");
		}
	}

	/** 정규화한 값(문자열 또는 null)들을 한 줄로 직렬화한다. */
	static String line(List<String> values) {
		StringBuilder out = new StringBuilder("[");
		for (int i = 0; i < values.size(); i++) {
			if (i > 0) {
				out.append(',');
			}
			String v = values.get(i);
			if (v == null) {
				out.append("null");
			}
			else {
				quote(v, out);
			}
		}
		return out.append(']').toString();
	}

	static void quote(String s, StringBuilder out) {
		out.append('"');
		for (int i = 0; i < s.length(); i++) {
			char c = s.charAt(i);
			switch (c) {
				case '"' -> out.append("\\\"");
				case '\\' -> out.append("\\\\");
				case '\b' -> out.append("\\b");
				case '\f' -> out.append("\\f");
				case '\n' -> out.append("\\n");
				case '\r' -> out.append("\\r");
				case '\t' -> out.append("\\t");
				default -> {
					boolean lone = Character.isSurrogate(c) && !(Character.isHighSurrogate(c) && i + 1 < s.length()
							&& Character.isLowSurrogate(s.charAt(i + 1)))
							&& !(Character.isLowSurrogate(c) && i > 0 && Character.isHighSurrogate(s.charAt(i - 1)));
					if (c < 0x20 || lone) {
						out.append(String.format("\\u%04x", (int) c));
					}
					else {
						out.append(c);
					}
				}
			}
		}
		out.append('"');
	}

	@SuppressWarnings("unchecked")
	private static void writeCanonical(Object value, StringBuilder out) {
		if (value == null) {
			out.append("null");
		}
		else if (value instanceof String s) {
			quote(s, out);
		}
		else if (value instanceof Boolean b) {
			out.append(b ? "true" : "false");
		}
		else if (value instanceof BigInteger n) {
			out.append(n);
		}
		else if (value instanceof List<?> list) {
			out.append('[');
			for (int i = 0; i < list.size(); i++) {
				if (i > 0) {
					out.append(',');
				}
				writeCanonical(list.get(i), out);
			}
			out.append(']');
		}
		else {
			out.append('{');
			boolean first = true;
			for (Map.Entry<String, Object> e : ((TreeMap<String, Object>) value).entrySet()) {
				if (!first) {
					out.append(',');
				}
				first = false;
				quote(e.getKey(), out);
				out.append(':');
				writeCanonical(e.getValue(), out);
			}
			out.append('}');
		}
	}

	/** 값 없는 오류만 내는 최소 JSON 파서. 숫자는 정수(또는 정수값인 실수 표기)만 받는다. */
	private static final class JsonParser {

		private final String s;

		private int pos;

		JsonParser(String s) {
			this.s = s;
		}

		Object parseDocument() {
			skipWs();
			Object v = parseValue();
			skipWs();
			if (pos != s.length()) {
				throw bad();
			}
			return v;
		}

		private static IllegalArgumentException bad() {
			return new IllegalArgumentException();
		}

		private void skipWs() {
			while (pos < s.length() && (s.charAt(pos) == ' ' || s.charAt(pos) == '\t' || s.charAt(pos) == '\n'
					|| s.charAt(pos) == '\r')) {
				pos++;
			}
		}

		private Object parseValue() {
			if (pos >= s.length()) {
				throw bad();
			}
			char c = s.charAt(pos);
			if (c == '{') {
				return parseObject();
			}
			if (c == '[') {
				return parseArray();
			}
			if (c == '"') {
				return parseString();
			}
			if (s.startsWith("true", pos)) {
				pos += 4;
				return Boolean.TRUE;
			}
			if (s.startsWith("false", pos)) {
				pos += 5;
				return Boolean.FALSE;
			}
			if (s.startsWith("null", pos)) {
				pos += 4;
				return null;
			}
			return parseNumber();
		}

		private Object parseObject() {
			TreeMap<String, Object> map = new TreeMap<>();
			pos++;
			skipWs();
			if (peek() == '}') {
				pos++;
				return map;
			}
			while (true) {
				skipWs();
				if (peek() != '"') {
					throw bad();
				}
				String key = parseString();
				skipWs();
				if (peek() != ':') {
					throw bad();
				}
				pos++;
				skipWs();
				map.put(key, parseValue());
				skipWs();
				char c = peek();
				pos++;
				if (c == '}') {
					return map;
				}
				if (c != ',') {
					throw bad();
				}
			}
		}

		private Object parseArray() {
			List<Object> list = new ArrayList<>();
			pos++;
			skipWs();
			if (peek() == ']') {
				pos++;
				return list;
			}
			while (true) {
				skipWs();
				list.add(parseValue());
				skipWs();
				char c = peek();
				pos++;
				if (c == ']') {
					return list;
				}
				if (c != ',') {
					throw bad();
				}
			}
		}

		private char peek() {
			if (pos >= s.length()) {
				throw bad();
			}
			return s.charAt(pos);
		}

		private String parseString() {
			pos++; // 여는 따옴표
			StringBuilder b = new StringBuilder();
			while (true) {
				char c = peek();
				pos++;
				if (c == '"') {
					return b.toString();
				}
				if (c < 0x20) {
					throw bad();
				}
				if (c != '\\') {
					b.append(c);
					continue;
				}
				char e = peek();
				pos++;
				switch (e) {
					case '"' -> b.append('"');
					case '\\' -> b.append('\\');
					case '/' -> b.append('/');
					case 'b' -> b.append('\b');
					case 'f' -> b.append('\f');
					case 'n' -> b.append('\n');
					case 'r' -> b.append('\r');
					case 't' -> b.append('\t');
					case 'u' -> {
						if (pos + 4 > s.length()) {
							throw bad();
						}
						String hex = s.substring(pos, pos + 4);
						for (int i = 0; i < 4; i++) {
							if (Character.digit(hex.charAt(i), 16) < 0) {
								throw bad();
							}
						}
						b.append((char) Integer.parseInt(hex, 16));
						pos += 4;
					}
					default -> throw bad();
				}
			}
		}

		private Object parseNumber() {
			int start = pos;
			while (pos < s.length() && "+-0123456789.eE".indexOf(s.charAt(pos)) >= 0) {
				pos++;
			}
			if (start == pos) {
				throw bad();
			}
			BigDecimal number;
			try {
				number = new BigDecimal(s.substring(start, pos));
			}
			catch (NumberFormatException e) {
				throw bad();
			}
			BigDecimal stripped = number.signum() == 0 ? BigDecimal.ZERO : number.stripTrailingZeros();
			if (stripped.scale() > 0 || stripped.precision() - stripped.scale() > 16) {
				throw bad(); // 소수이거나 너무 큰 수
			}
			BigInteger integer = stripped.toBigIntegerExact();
			if (integer.abs().compareTo(MAX_SAFE) > 0) {
				throw bad();
			}
			return integer;
		}

	}

}
