package com.auctionboss.item.search;

import java.util.Optional;

/** 정렬 기준. {@code param}은 URL 파라미터 값이다. */
public enum SortKey {

	AUCTION_DATE("auctionDate"), MIN_BID_PRICE("minBidPrice"), BID_RATIO("bidRatio"),
	FAILED_BID_COUNT("failedBidCount"), PRICE_PER_AREA("pricePerArea");

	public static final String PARAM_LIST = "auctionDate, minBidPrice, bidRatio, failedBidCount, pricePerArea";

	private final String param;

	SortKey(String param) {
		this.param = param;
	}

	public String param() {
		return param;
	}

	public static Optional<SortKey> fromParam(String value) {
		for (SortKey k : values()) {
			if (k.param.equals(value)) {
				return Optional.of(k);
			}
		}
		return Optional.empty();
	}

}
