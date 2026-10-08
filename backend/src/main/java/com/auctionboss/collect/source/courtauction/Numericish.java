package com.auctionboss.collect.source.courtauction;

/** 소스가 문자열이나 숫자 어느 쪽으로 줘도 받는 값(zod {@code string | number}). */
record Numericish(String text, Double number) {

	static Numericish ofText(String text) {
		return new Numericish(text, null);
	}

	static Numericish ofNumber(double number) {
		return new Numericish(null, number);
	}

	/** JS {@code Number(value)}. */
	double toJsNumber() {
		return number != null ? number : JsValues.toNumber(text);
	}

}
