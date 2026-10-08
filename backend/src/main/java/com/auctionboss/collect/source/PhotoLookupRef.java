package com.auctionboss.collect.source;

/** 사진 조회 입력. 정규화 물건이 보존한 소스 중립 필드다. */
public record PhotoLookupRef(String courtCode, String internalCaseNo) {
}
