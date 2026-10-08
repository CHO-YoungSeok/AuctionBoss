package com.auctionboss.collect.source;

/** 로봇탐지 IP 차단. HTTP 200이지만 소스가 통과 표시를 주지 않았다. */
public class RobotDetectedException extends SourceBlockedException {

	private final String sourceMessage;

	public RobotDetectedException(String message, String sourceMessage) {
		super(message);
		this.sourceMessage = sourceMessage;
	}

	@Override
	public String kind() {
		return "RobotDetectedError";
	}

	/** 소스가 준 안내 문구. 없으면 null. */
	public String sourceMessage() {
		return sourceMessage;
	}

}
