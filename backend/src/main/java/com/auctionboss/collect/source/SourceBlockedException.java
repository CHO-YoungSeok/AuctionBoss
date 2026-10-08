package com.auctionboss.collect.source;

/** 소스가 우리 접근을 막았다. 재시도·쿠키 재발급으로 풀리지 않으므로 스케줄러는 이 오류를 보면 장시간 백오프에 들어간다. */
public class SourceBlockedException extends SourceException {

	protected SourceBlockedException(String message) {
		super(message, null);
	}

	@Override
	public String kind() {
		return "SourceBlockedError";
	}

}
