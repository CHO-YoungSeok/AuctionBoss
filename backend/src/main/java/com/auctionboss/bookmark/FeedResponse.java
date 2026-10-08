package com.auctionboss.bookmark;

import java.util.List;

/** 피드 응답 {@code { entries, total, page, pageSize, unreadCount }}. */
public record FeedResponse(List<FeedEntryResponse> entries, long total, long page, int pageSize, long unreadCount) {
}
