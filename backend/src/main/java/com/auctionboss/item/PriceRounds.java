package com.auctionboss.item;

import jakarta.persistence.Embeddable;

/** 차수별 최저매각가격(1~4차)과 최저매각가율(1~2차). 금액은 원 단위 Long. */
@Embeddable
public record PriceRounds(Long minBidPriceRound1, Long minBidPriceRound2, Long minBidPriceRound3,
		Long minBidPriceRound4, Integer minBidPriceRateRound1, Integer minBidPriceRateRound2) {
}
