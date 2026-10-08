package com.auctionboss.item.search;

import java.util.List;

import com.auctionboss.item.dto.ItemResponse;

/** 목록 응답 {@code { items, total, page, pageSize }}. */
public record ItemPage(List<ItemResponse> items, long total, long page, int pageSize) {
}
