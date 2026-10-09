package com.auctionboss.collect.run;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.Map;
import java.util.stream.Stream;

import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.read.ListAppender;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.Arguments;
import org.junit.jupiter.params.provider.MethodSource;
import org.slf4j.LoggerFactory;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;
import org.springframework.context.ConfigurableApplicationContext;
import org.springframework.core.env.StandardEnvironment;
import org.springframework.core.env.SystemEnvironmentPropertySource;
import org.springframework.scheduling.concurrent.ThreadPoolTaskScheduler;

/**
 * docs/REFERENCE.md 8절 표의 환경 변수 이름이 실제로 그 속성에 바인딩되는지(Spring의 SystemEnvironmentPropertySource 규칙)를 고정한다.
 * 문서에 적힌 이름이 틀려도 기동은 조용히 성공하고 설정만 무시되므로(기본값으로 돈다) 다른 테스트로는 잡히지 않는다.
 * 실제 프로세스 환경 변수는 건드리지 않는다: 시스템 환경 속성 소스를 가짜 맵으로 바꾼다.
 */
class EnvironmentVariableBindingTest {

	private static ApplicationContextRunner runnerWithEnv(Map<String, Object> env) {
		return new ApplicationContextRunner().withInitializer(ctx -> ctx.getEnvironment()
			.getPropertySources()
			.replace(StandardEnvironment.SYSTEM_ENVIRONMENT_PROPERTY_SOURCE_NAME,
					new SystemEnvironmentPropertySource(StandardEnvironment.SYSTEM_ENVIRONMENT_PROPERTY_SOURCE_NAME, env)));
	}

	static Stream<Arguments> documented() {
		return Stream.of(Arguments.of("AUCTIONBOSS_COLLECTOR_ENABLED", "auctionboss.collector.enabled"),
				Arguments.of("AUCTIONBOSS_PHOTOS_ENABLED", "auctionboss.photos.enabled"),
				Arguments.of("AUCTIONBOSS_SOURCE_EXTERNAL_REQUESTS_ALLOWED", "auctionboss.source.external-requests-allowed"),
				Arguments.of("AUCTIONBOSS_SOURCE_BASE_URL", "auctionboss.source.base-url"),
				Arguments.of("AUCTIONBOSS_SOURCE_PAGE_SIZE", "auctionboss.source.page-size"),
				Arguments.of("AUCTIONBOSS_SOURCE_PAGE_DELAY_MS", "auctionboss.source.page-delay-ms"),
				Arguments.of("AUCTIONBOSS_SOURCE_BID_WINDOW_DAYS", "auctionboss.source.bid-window-days"),
				Arguments.of("AUCTIONBOSS_SOURCE_MAX_PAGES", "auctionboss.source.max-pages"),
				Arguments.of("AUCTIONBOSS_COLLECTOR_RUN_IMMEDIATELY", "auctionboss.collector.run-immediately"),
				Arguments.of("AUCTIONBOSS_PHOTOS_RUN_IMMEDIATELY", "auctionboss.photos.run-immediately"),
				Arguments.of("AUCTIONBOSS_COLLECTOR_MAX_COURTS_PER_RUN", "auctionboss.collector.max-courts-per-run"),
				Arguments.of("AUCTIONBOSS_COLLECTOR_MAX_REQUESTS_PER_RUN", "auctionboss.collector.max-requests-per-run"),
				Arguments.of("AUCTIONBOSS_COLLECTOR_BLOCK_BACKOFF_MS", "auctionboss.collector.block-backoff-ms"),
				Arguments.of("AUCTIONBOSS_PHOTOS_MAX_ITEMS_PER_RUN", "auctionboss.photos.max-items-per-run"),
				Arguments.of("AUCTIONBOSS_PHOTOS_DIR", "auctionboss.photos.dir"),
				Arguments.of("AUCTIONBOSS_CONFIG_PATH", "auctionboss.config-path"),
				Arguments.of("AUCTIONBOSS_WORKERS_SHUTDOWN_WAIT_MS", "auctionboss.workers.shutdown-wait-ms"),
				Arguments.of("AUCTIONBOSS_RUN_ONCE", "auctionboss.run-once"),
				Arguments.of("AUCTIONBOSS_RUN_ONCE_TIMEOUT_MS", "auctionboss.run-once-timeout-ms"));
	}

	@ParameterizedTest(name = "{0} -> {1}")
	@MethodSource("documented")
	void 문서의_환경_변수_이름이_그_속성에_바인딩된다(String envName, String property) {
		runnerWithEnv(Map.of(envName, "값")).run(ctx -> assertThat(ctx.getEnvironment().getProperty(property)).isEqualTo("값"));
	}

	@Test
	void 환경_변수가_없으면_속성도_없다() {
		runnerWithEnv(Map.of()).run(ctx -> assertThat(ctx.getEnvironment().getProperty("auctionboss.collector.enabled")).isNull());
	}

	@Test
	void 환경_변수로_켠_설정을_기동_로그가_켜짐으로_남긴다() {
		ListAppender<ILoggingEvent> logs = new ListAppender<>();
		logs.start();
		Logger logger = (Logger) LoggerFactory.getLogger(SchedulerStatusLogger.class);
		logger.addAppender(logs);
		try {
			runnerWithEnv(Map.of("AUCTIONBOSS_COLLECTOR_ENABLED", "true", "AUCTIONBOSS_PHOTOS_ENABLED", "true",
					"AUCTIONBOSS_SOURCE_EXTERNAL_REQUESTS_ALLOWED", "true"))
				.withUserConfiguration(SchedulerStatusLogger.class)
				.run(ctx -> assertThat(logs.list).extracting(ILoggingEvent::getFormattedMessage)
					.containsExactly("[scheduler] 수집 워커 켜짐, 사진 워커 켜짐, 외부 요청 허용 켜짐"));
		}
		finally {
			logger.detachAppender(logs);
		}
	}

	@Test
	void 환경_변수로_사진만_켜도_스케줄러_설정이_만들어지고_꺼져_있으면_없다() {
		runnerWithEnv(Map.of("AUCTIONBOSS_PHOTOS_ENABLED", "true")).withUserConfiguration(SchedulingConfig.class)
			.run((ConfigurableApplicationContext ctx) -> assertThat(ctx.getBeansOfType(ThreadPoolTaskScheduler.class)).hasSize(1));
		runnerWithEnv(Map.of()).withUserConfiguration(SchedulingConfig.class)
			.run(ctx -> assertThat(ctx.getBeansOfType(ThreadPoolTaskScheduler.class)).isEmpty());
	}

}
