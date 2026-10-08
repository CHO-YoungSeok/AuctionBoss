package com.auctionboss.photo;

import java.util.OptionalDouble;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** JS {@code parseInt(value, 10)}: 앞쪽 공백 뒤의 부호와 10진 숫자만 읽고 나머지는 버린다. 숫자가 없으면 NaN(비어 있음). */
final class JsInts {

	private static final Pattern LEADING = Pattern.compile("^[\\s\\p{Z}\\uFEFF]*([+-]?[0-9]+)");

	private JsInts() {
	}

	static OptionalDouble parseInt(String value) {
		Matcher m = LEADING.matcher(value);
		if (!m.find()) {
			return OptionalDouble.empty();
		}
		return OptionalDouble.of(Double.parseDouble(m.group(1)));
	}

}
