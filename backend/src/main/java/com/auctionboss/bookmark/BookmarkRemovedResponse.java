package com.auctionboss.bookmark;

/** 관심 해제 응답 {@code { itemId, bookmarked: false }}. */
public record BookmarkRemovedResponse(long itemId, boolean bookmarked) {
}
