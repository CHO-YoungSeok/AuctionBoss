package com.auctionboss.migration;

import java.nio.file.Path;
import java.time.Instant;
import java.time.format.DateTimeParseException;

import com.auctionboss.collect.run.BackoffStore;
import com.auctionboss.collect.collector.RotationStore;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.jdbc.core.JdbcTemplate;

/**
 * 이전·롤백용 1회 실행 모드의 빈(design D5, D11). {@code auctionboss.run-once}가 {@code import}, {@code export-state},
 * {@code delta-report}일 때만 만들어진다(수집·사진 1회 실행은 {@code collect.runonce}가 맡는다). 웹 서버는
 * {@code RunOnceEnvironmentPostProcessor}가 띄우지 않게 한다. 세 모드 모두 수집·사진 스케줄러를 켜는 설정과 함께 쓸 수 없다(같은 회차를
 * 겹쳐 돌리거나 이전 중에 소스에 요청하지 않게).
 */
@Configuration(proxyBeanMethods = false)
class MigrationRunOnceConfig {

	private static void refuseSchedulers(boolean collectorEnabled, boolean photosEnabled, String mode) {
		if (collectorEnabled || photosEnabled) {
			throw new IllegalStateException("auctionboss.run-once=" + mode + "는 스케줄러를 켜는 설정(auctionboss.collector.enabled, "
					+ "auctionboss.photos.enabled)과 함께 쓸 수 없습니다");
		}
	}

	@Bean
	@ConditionalOnProperty(name = "auctionboss.run-once", havingValue = "import")
	ImportRunner importRunner(ImportService service, @Value("${auctionboss.import.dir:}") String dir,
			@Value("${auctionboss.import.replace:false}") boolean replace,
			@Value("${auctionboss.import.dry-run:false}") boolean dryRun,
			@Value("${auctionboss.collector.enabled:false}") boolean collectorEnabled,
			@Value("${auctionboss.photos.enabled:false}") boolean photosEnabled) {
		refuseSchedulers(collectorEnabled, photosEnabled, "import");
		if (dir.isBlank()) {
			throw new IllegalStateException("auctionboss.import.dir(내보내기 결과 디렉터리)가 필요합니다");
		}
		return new ImportRunner(service, new ImportOptions(Path.of(dir), replace, dryRun));
	}

	@Bean
	@ConditionalOnProperty(name = "auctionboss.run-once", havingValue = "export-state")
	StateExportRunner stateExportRunner(BackoffStore backoff, RotationStore rotation,
			@Value("${auctionboss.collector.enabled:false}") boolean collectorEnabled,
			@Value("${auctionboss.photos.enabled:false}") boolean photosEnabled) {
		refuseSchedulers(collectorEnabled, photosEnabled, "export-state");
		return new StateExportRunner(new StateExporter(backoff, rotation));
	}

	@Bean
	@ConditionalOnProperty(name = "auctionboss.run-once", havingValue = "delta-report")
	DeltaReportRunner deltaReportRunner(JdbcTemplate jdbc, @Value("${auctionboss.delta.since:}") String since,
			@Value("${auctionboss.collector.enabled:false}") boolean collectorEnabled,
			@Value("${auctionboss.photos.enabled:false}") boolean photosEnabled) {
		refuseSchedulers(collectorEnabled, photosEnabled, "delta-report");
		if (since.isBlank()) {
			throw new IllegalStateException("auctionboss.delta.since(전환 시각, 예: 2026-10-09T01:02:03.000Z)가 필요합니다");
		}
		try {
			return new DeltaReportRunner(new DeltaReporter(jdbc), Instant.parse(since));
		}
		catch (DateTimeParseException e) {
			throw new IllegalStateException("auctionboss.delta.since는 ISO-8601 UTC 시각이어야 합니다");
		}
	}

}
