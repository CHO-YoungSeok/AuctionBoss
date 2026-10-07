package com.auctionboss.item;

import jakarta.persistence.Embeddable;

/** 용도 대/중/소분류 코드. 코드표 미확인이라 원문 문자열 그대로 둔다. */
@Embeddable
public record UsageCodes(String usageCodeLarge, String usageCodeMedium, String usageCodeSmall) {
}
