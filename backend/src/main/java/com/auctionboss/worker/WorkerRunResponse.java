package com.auctionboss.worker;

import java.time.Instant;
import java.util.Map;

/** 회차 한 건 응답. 필드 이름과 순서는 원본 {@code WorkerRun}(toWorkerRun)과 같다. */
public record WorkerRunResponse(Long id, String worker, Instant startedAt, Instant finishedAt, String outcome,
		String errorKind, String errorMessage, Map<String, Object> detail, Integer itemsChanged) {

	public static WorkerRunResponse of(WorkerRun r) {
		return new WorkerRunResponse(r.getId(), r.getWorker(), r.getStartedAt(), r.getFinishedAt(),
				r.getOutcome().dbValue(), r.getErrorKind(), r.getErrorMessage(), r.getDetail(), r.getItemsChanged());
	}

}
