package com.auctionboss.worker;

import java.time.Instant;

/** 워커 상태 판정. {@code state}는 ok, blocked, failed, stale 중 하나다. */
public record WorkerStatusResponse(String state, Instant lastSuccessAt, WorkerRunResponse lastRun) {
}
