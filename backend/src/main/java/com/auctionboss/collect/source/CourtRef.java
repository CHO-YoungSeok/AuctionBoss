package com.auctionboss.collect.source;

/** 수집 대상 법원 한 곳. {@code courtCode}가 빈 문자열이면 어댑터가 법원 이름으로 코드를 찾는다. */
public record CourtRef(String name, String courtCode) {
}
