package com.auctionboss.common.json;

import java.math.BigDecimal;

/** JS 숫자 규칙(정수 값의 실수는 정수로 쓴다)을 따르는 변환 도구. */
public final class JsNumbers {

	/** JS가 정수를 지수 없이 쓰는 상한(1e21 미만). */
	private static final double PLAIN_LIMIT = 1e21;

	private JsNumbers() {
	}

	public static boolean isIntegral(double d) {
		return !Double.isNaN(d) && !Double.isInfinite(d) && d == Math.rint(d);
	}

	/** 정수 값이면 Long(범위를 넘으면 그대로 Double), 아니면 Double. {@code 3.0} -> {@code 3}. */
	public static Object normalize(double d) {
		if (isIntegral(d) && Math.abs(d) < 9.2e18) {
			return (long) d;
		}
		return d;
	}

	/** JS의 {@code String(number)}와 같은 표기. 오류 메시지의 id 표기에 쓴다. */
	public static String format(double d) {
		if (Double.isNaN(d)) {
			return "NaN";
		}
		if (Double.isInfinite(d)) {
			return d > 0 ? "Infinity" : "-Infinity";
		}
		double abs = Math.abs(d);
		if (isIntegral(d) && abs < PLAIN_LIMIT) {
			return new BigDecimal(d).toBigInteger().toString();
		}
		if (abs >= 1e-6 && abs < PLAIN_LIMIT) {
			return BigDecimal.valueOf(d).stripTrailingZeros().toPlainString();
		}
		// 지수 표기: 1e+21, 1.5e-7
		String s = Double.toString(d);
		int e = s.indexOf('E');
		String mantissa = s.substring(0, e);
		String exp = s.substring(e + 1);
		if (mantissa.endsWith(".0")) {
			mantissa = mantissa.substring(0, mantissa.length() - 2);
		}
		return mantissa + "e" + (exp.startsWith("-") ? exp : "+" + exp);
	}

}
