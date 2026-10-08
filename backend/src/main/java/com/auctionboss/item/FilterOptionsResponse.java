package com.auctionboss.item;

import java.util.List;

/** 목록 화면의 필터 선택지. 필드 이름과 순서는 Next {@code /api/items/filter-options}와 같다. */
public record FilterOptionsResponse(List<String> usageTypes, List<String> sidoValues, List<String> sigunguValues,
		List<String> courtValues) {
}
