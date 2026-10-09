package com.auctionboss.migration;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.boot.ExitCodeGenerator;

/** 1회 실행 모드 {@code auctionboss.run-once=import}: 가져오기를 한 번 하고 종료 코드(성공 0, 실패 1)를 낸다. */
public final class ImportRunner implements ApplicationRunner, ExitCodeGenerator {

	private static final Logger log = LoggerFactory.getLogger(ImportRunner.class);

	private final ImportService service;

	private final ImportOptions options;

	private volatile int exitCode = 1;

	ImportRunner(ImportService service, ImportOptions options) {
		this.service = service;
		this.options = options;
	}

	@Override
	public void run(ApplicationArguments args) {
		ImportReport report = service.run(options);
		report.lines().forEach(line -> log.info("[import] {}", line));
		exitCode = report.success() ? 0 : 1;
		log.info("[import] 종료 코드 {}", exitCode);
	}

	@Override
	public int getExitCode() {
		return exitCode;
	}

}
