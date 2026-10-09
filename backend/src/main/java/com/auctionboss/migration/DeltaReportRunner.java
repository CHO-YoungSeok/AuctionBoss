package com.auctionboss.migration;

import java.time.Instant;

import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.boot.ExitCodeGenerator;

/** 1회 실행 모드 {@code auctionboss.run-once=delta-report}: 기준 시각 이후 건수를 표준 출력 한 줄 JSON으로 쓴다. */
public final class DeltaReportRunner implements ApplicationRunner, ExitCodeGenerator {

	private final DeltaReporter reporter;

	private final Instant since;

	private volatile int exitCode = 1;

	DeltaReportRunner(DeltaReporter reporter, Instant since) {
		this.reporter = reporter;
		this.since = since;
	}

	@Override
	public void run(ApplicationArguments args) {
		System.out.println(reporter.report(since));
		exitCode = 0;
	}

	@Override
	public int getExitCode() {
		return exitCode;
	}

}
