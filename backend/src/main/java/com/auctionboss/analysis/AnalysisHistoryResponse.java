package com.auctionboss.analysis;

import java.util.List;

/** 분석 이력 응답. {@code total}은 {@code limit}과 무관한 그 물건의 전체 분석 건수다. */
public record AnalysisHistoryResponse(List<AnalysisResponse> analyses, long total) {
}
