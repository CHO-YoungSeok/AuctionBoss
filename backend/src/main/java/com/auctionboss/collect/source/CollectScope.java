package com.auctionboss.collect.source;

import java.util.List;

/** 수집 범위. {@link AuctionSource#fetchActiveItems}의 인자. */
public record CollectScope(List<CourtRef> courts) {

	public CollectScope {
		courts = List.copyOf(courts);
	}

}
