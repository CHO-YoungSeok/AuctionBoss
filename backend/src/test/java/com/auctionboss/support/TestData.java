package com.auctionboss.support;

import java.time.Instant;

import com.auctionboss.item.Item;

public final class TestData {

	public static final Instant T0 = Instant.parse("2026-09-08T11:48:38.617Z");

	private TestData() {
	}

	public static Item.Builder item(String caseNo, String itemNo) {
		return Item.builder("서울중앙지방법원", caseNo, itemNo, T0, T0);
	}

}
