package com.auctionboss.analysis;

/** 검증을 마친 분석 저장 요청. {@code itemId}는 JS 숫자(double)다. {@code model}은 없으면 null. */
public record NewAnalysis(double itemId, String body, String promptVersion, String model) {
}
