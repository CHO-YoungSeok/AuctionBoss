package com.auctionboss.collect.source.courtauction;

import java.math.BigInteger;
import java.util.regex.Pattern;

/**
 * TS 어댑터가 쓰는 JavaScript 값 변환의 Java 재현: {@code String.prototype.trim}의 공백 집합과 {@code Number(string)}의 문법,
 * {@code Math.trunc}. 소스가 보낸 문자열을 TS와 같은 값으로 읽기 위한 것이다(design D9).
 */
final class JsValues {

	private static final Pattern DECIMAL = Pattern
		.compile("[+-]?(?:\\d+\\.?\\d*(?:[eE][+-]?\\d+)?|\\.\\d+(?:[eE][+-]?\\d+)?)");

	private static final Pattern HEX = Pattern.compile("0[xX][0-9a-fA-F]+");

	private static final Pattern OCTAL = Pattern.compile("0[oO][0-7]+");

	private static final Pattern BINARY = Pattern.compile("0[bB][01]+");

	private static final double LONG_LIMIT = 9.223372036854775808E18;

	private JsValues() {
	}

	/** JS {@code trim()}이 지우는 공백(Java {@code strip()}과 집합이 다르다: NBSP·BOM 포함). */
	static boolean isSpace(char c) {
		return switch (c) {
			case '\t', '\n', 0x0B, '\f', '\r', ' ', 0xA0, 0x1680, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF -> true;
			default -> c >= 0x2000 && c <= 0x200A;
		};
	}

	static String trim(String s) {
		int start = 0;
		int end = s.length();
		while (start < end && isSpace(s.charAt(start))) {
			start++;
		}
		while (end > start && isSpace(s.charAt(end - 1))) {
			end--;
		}
		return s.substring(start, end);
	}

	static String trimStart(String s) {
		int start = 0;
		while (start < s.length() && isSpace(s.charAt(start))) {
			start++;
		}
		return s.substring(start);
	}

	/** JS {@code Number(string)}. 숫자가 아니면 NaN. 빈 문자열·공백만 있는 문자열은 0. */
	static double toNumber(String raw) {
		String s = trim(raw);
		if (s.isEmpty()) {
			return 0;
		}
		if (DECIMAL.matcher(s).matches()) {
			return Double.parseDouble(s);
		}
		if (HEX.matcher(s).matches()) {
			return new BigInteger(s.substring(2), 16).doubleValue();
		}
		if (OCTAL.matcher(s).matches()) {
			return new BigInteger(s.substring(2), 8).doubleValue();
		}
		if (BINARY.matcher(s).matches()) {
			return new BigInteger(s.substring(2), 2).doubleValue();
		}
		return switch (s) {
			case "Infinity", "+Infinity" -> Double.POSITIVE_INFINITY;
			case "-Infinity" -> Double.NEGATIVE_INFINITY;
			default -> Double.NaN;
		};
	}

	/**
	 * {@code Math.trunc} 뒤 {@code Long}. 유한하지 않거나 {@code Long} 범위 밖이면 null(TS는 범위 밖 값을 그대로 통과시키지만
	 * Java 모델은 {@code Long}이라 변환 불가로 다룬다. design D9).
	 */
	static Long truncToLong(double d) {
		if (Double.isNaN(d) || Double.isInfinite(d) || d >= LONG_LIMIT || d < -LONG_LIMIT) {
			return null;
		}
		return (long) d;
	}

}
