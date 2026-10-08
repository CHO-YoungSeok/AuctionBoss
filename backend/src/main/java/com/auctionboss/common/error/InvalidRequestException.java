package com.auctionboss.common.error;

import java.util.List;

/** 요청 파라미터 검증 실패. 400과 {@code details}로 변환된다. */
public class InvalidRequestException extends RuntimeException {

	public static final String MESSAGE = "잘못된 요청 파라미터입니다";

	private final List<FieldIssue> issues;

	public InvalidRequestException(List<FieldIssue> issues) {
		super(MESSAGE);
		this.issues = List.copyOf(issues);
	}

	/** 요청 본문 검증 실패용. 메시지는 엔드포인트마다 다르고, {@code issues}가 null이면 응답에서 {@code details}를 뺀다. */
	public InvalidRequestException(String message, List<FieldIssue> issues) {
		super(message);
		this.issues = issues == null ? null : List.copyOf(issues);
	}

	public List<FieldIssue> getIssues() {
		return issues;
	}

}
