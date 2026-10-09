package com.auctionboss.collect.collector;

import com.auctionboss.collect.source.SourceItem;

/** 저장 테스트용 {@link SourceItem} 만들기. 감시 필드 외에는 고정 값이다. */
final class TestItems {

	private TestItems() {
	}

	static SourceItem item(String caseNo, Long minBidPrice, Long failedBidCount, String auctionDate, String status) {
		return item("서울중앙지방법원", caseNo, "1", "서울특별시 종로구 시험로 1", minBidPrice, failedBidCount, auctionDate, status);
	}

	static SourceItem item(String court, String caseNo, String itemNo, String address, Long minBidPrice,
			Long failedBidCount, String auctionDate, String status) {
		return new SourceItem(court, caseNo, itemNo, address, "아파트", 300_000_000L, minBidPrice, auctionDate,
				failedBidCount, status, null, null, null, null, null, null, null, null, null, null, null, null, null,
				null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null,
				null, null, null, null);
	}

	static SourceItem withAddress(SourceItem i, String address) {
		return item(i.court(), i.caseNo(), i.itemNo(), address, i.minBidPrice(), i.failedBidCount(), i.auctionDate(),
				i.status());
	}

}
