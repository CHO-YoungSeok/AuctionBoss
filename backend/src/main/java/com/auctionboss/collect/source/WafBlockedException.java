package com.auctionboss.collect.source;

/** WAF HTML 차단 페이지. HTTP는 200이고 본문만 HTML이라 상태 코드로는 감지할 수 없다. */
public class WafBlockedException extends SourceBlockedException {

	private final String bodyPreview;

	public WafBlockedException(String message, String bodyPreview) {
		super(message);
		this.bodyPreview = bodyPreview;
	}

	@Override
	public String kind() {
		return "WafBlockedError";
	}

	public String bodyPreview() {
		return bodyPreview;
	}

}
