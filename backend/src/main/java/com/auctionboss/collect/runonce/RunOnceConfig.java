package com.auctionboss.collect.runonce;

import java.time.Duration;

import com.auctionboss.collect.collector.CollectorRun;
import com.auctionboss.collect.photos.PhotoRun;
import com.auctionboss.collect.run.BackoffStore;
import com.auctionboss.collect.run.RunLock;
import com.auctionboss.common.time.ServerClock;
import com.auctionboss.worker.WorkerRunService;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.condition.ConditionalOnExpression;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/**
 * 1회 실행 모드의 빈(design D11). {@code auctionboss.run-once}를 명시해야만 존재한다(기본 꺼짐). 값은 {@code collector} 또는
 * {@code photos}이고(이전·롤백 모드 {@code import}·{@code export-state}·{@code delta-report}는 migration 패키지가 맡는다) 그 밖의 값, 그리고 스케줄러를 켜는 설정({@code auctionboss.collector.enabled},
 * {@code auctionboss.photos.enabled})과의 동시 지정은 기동 실패다(둘이 같은 회차를 겹쳐 돌리지 않게).
 *
 * <p>
 * 웹 서버는 띄우지 않는다: {@link RunOnceEnvironmentPostProcessor}가 이 속성이 있으면 {@code spring.main.web-application-type=none}을 더한다.
 */
@Configuration(proxyBeanMethods = false)
@ConditionalOnProperty(name = "auctionboss.run-once")
// 이전·롤백 모드(import, export-state, delta-report)는 com.auctionboss.migration이 맡는다. 그 밖의 값은 여기서 기동 실패가 된다.
@ConditionalOnExpression("!'${auctionboss.run-once:}'.matches('import|export-state|delta-report')")
class RunOnceConfig {

	@Bean
	RunOnceRunner runOnceRunner(@Value("${auctionboss.run-once}") String mode,
			@Value("${auctionboss.collector.enabled:false}") boolean collectorEnabled,
			@Value("${auctionboss.photos.enabled:false}") boolean photosEnabled,
			@Value("${auctionboss.run-once-timeout-ms:1800000}") long timeoutMs, CollectorRun collector, PhotoRun photos,
			RunLock lock, BackoffStore backoff, WorkerRunService runs, ServerClock clock) {
		if (collectorEnabled || photosEnabled) {
			throw new IllegalStateException("auctionboss.run-once는 스케줄러를 켜는 설정(auctionboss.collector.enabled, "
					+ "auctionboss.photos.enabled)과 함께 쓸 수 없습니다");
		}
		RunOnceRunner.Target target = switch (mode) {
			case "collector" -> new RunOnceRunner.Target(CollectorRun.WORKER, CollectorRun.LOCK_NAME,
					() -> collector.run().outcome());
			case "photos" -> new RunOnceRunner.Target(PhotoRun.WORKER, PhotoRun.LOCK_NAME,
					() -> photos.run().outcome());
			default -> throw new IllegalStateException(
					"auctionboss.run-once는 collector 또는 photos여야 합니다: '" + mode + "'");
		};
		return new RunOnceRunner(target, lock, backoff, runs, clock, Duration.ofMillis(timeoutMs));
	}

}
