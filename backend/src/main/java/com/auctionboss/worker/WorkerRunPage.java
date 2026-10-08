package com.auctionboss.worker;

import java.util.List;

/** 회차 목록 응답 {@code { runs, total, page, pageSize }}. */
public record WorkerRunPage(List<WorkerRunResponse> runs, long total, long page, int pageSize) {
}
