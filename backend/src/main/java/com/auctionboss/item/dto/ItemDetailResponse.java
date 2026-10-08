package com.auctionboss.item.dto;

import com.auctionboss.analysis.AnalysisResponse;

/** 상세 응답 {@code { item, analysis }}. 분석이 없으면 analysis는 null이다. */
public record ItemDetailResponse(ItemResponse item, AnalysisResponse analysis) {
}
