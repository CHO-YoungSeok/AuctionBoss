package com.auctionboss.analysis;

import java.time.Instant;

/** 최신 분석 응답. 필드 이름과 순서는 원본 {@code Analysis}(toAnalysis)와 같다. */
public record AnalysisResponse(Long id, Long itemId, String body, String model, String promptVersion,
		Instant analyzedAt) {

	public static AnalysisResponse of(Analysis a, long itemId) {
		return new AnalysisResponse(a.getId(), itemId, a.getBody(), a.getModel(), a.getPromptVersion(),
				a.getAnalyzedAt());
	}

}
