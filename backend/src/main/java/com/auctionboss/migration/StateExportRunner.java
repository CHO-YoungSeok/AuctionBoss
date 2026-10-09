package com.auctionboss.migration;

import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.boot.ExitCodeGenerator;

/** 1회 실행 모드 {@code auctionboss.run-once=export-state}: 상태 JSON을 표준 출력 한 줄로 쓴다. */
public final class StateExportRunner implements ApplicationRunner, ExitCodeGenerator {

	private final StateExporter exporter;

	private volatile int exitCode = 1;

	StateExportRunner(StateExporter exporter) {
		this.exporter = exporter;
	}

	@Override
	public void run(ApplicationArguments args) {
		System.out.println(exporter.export());
		exitCode = 0;
	}

	@Override
	public int getExitCode() {
		return exitCode;
	}

}
