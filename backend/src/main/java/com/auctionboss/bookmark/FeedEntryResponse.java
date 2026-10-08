package com.auctionboss.bookmark;

import java.time.Instant;

/** 피드 항목. 필드 이름과 순서는 원본 {@code FeedEntry}(toFeedEntry)와 같다. */
public record FeedEntryResponse(Long id, Long itemId, String itemAddress, String field, String oldValue,
		String newValue, Instant changedAt, Instant bookmarkedAt) {
}
