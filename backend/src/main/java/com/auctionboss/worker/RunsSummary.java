package com.auctionboss.worker;

/** 회차 집계 응답. {@code successRate}는 완료된 회차가 없으면 null이다. */
public record RunsSummary(long totalRuns, long successCount, long failedCount, long blockedCount, long skippedCount,
		long runningCount, Double successRate, long itemsChanged) {
}
