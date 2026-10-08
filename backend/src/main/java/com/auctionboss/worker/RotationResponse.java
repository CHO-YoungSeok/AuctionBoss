package com.auctionboss.worker;

/** 수집기가 다음 회차에 처리할 법원 코드. 기록이 없으면 null. */
public record RotationResponse(String nextCourtCode) {
}
