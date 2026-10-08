package com.auctionboss.bookmark;

import java.time.Instant;

/** 읽음 처리 응답 {@code { lastReadAt, unreadCount }}. */
public record FeedReadResponse(Instant lastReadAt, long unreadCount) {
}
