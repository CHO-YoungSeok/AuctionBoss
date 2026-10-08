package com.auctionboss.common.json;

import java.util.regex.Pattern;

/** JS 문자열 규칙 도구. */
public final class JsStrings {

	/** JS String.prototype.trim()이 지우는 공백류(유니코드 공백, 줄바꿈, BOM). */
	private static final Pattern JS_TRIM = Pattern.compile("^[\\s\\p{Z}\\uFEFF]+|[\\s\\p{Z}\\uFEFF]+$");

	private JsStrings() {
	}

	public static String trim(String value) {
		return JS_TRIM.matcher(value).replaceAll("");
	}

}
