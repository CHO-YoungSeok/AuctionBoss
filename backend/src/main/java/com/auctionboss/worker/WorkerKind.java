package com.auctionboss.worker;

import java.util.List;

/** worker_runs.worker 값. */
public final class WorkerKind {

	public static final List<String> ALL = List.of("collector", "analyzer", "photos");

	private WorkerKind() {
	}

}
