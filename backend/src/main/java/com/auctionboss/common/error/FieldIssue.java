package com.auctionboss.common.error;

/** 검증 실패 한 건. {@code field}는 URL 파라미터 이름이다. */
public record FieldIssue(String field, String message) {
}
