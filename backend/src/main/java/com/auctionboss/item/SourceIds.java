package com.auctionboss.item;

import jakarta.persistence.Embeddable;

/** 소스 고유 식별자와 원시 상태 코드. 해석하지 않고 원문을 보존한다(상세 조회 대비). */
@Embeddable
public record SourceIds(String internalCaseNo, String courtCode, String statusCode, String itemStatusCode) {
}
