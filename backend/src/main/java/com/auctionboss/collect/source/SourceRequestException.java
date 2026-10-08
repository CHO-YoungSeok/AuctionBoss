package com.auctionboss.collect.source;

/** 네트워크 실패, HTTP 상태 이상, 외부 요청 불허. 차단이 아니므로 백오프를 걸지 않는다. */
public class SourceRequestException extends SourceException {

	private final String url;

	private final Integer status;

	public SourceRequestException(String message, String url, Integer status, Throwable cause) {
		super(message, cause);
		this.url = url;
		this.status = status;
	}

	public SourceRequestException(String message, String url) {
		this(message, url, null, null);
	}

	@Override
	public String kind() {
		return "SourceRequestError";
	}

	public String url() {
		return url;
	}

	/** HTTP 상태. 네트워크 오류면 null. */
	public Integer status() {
		return status;
	}

}
