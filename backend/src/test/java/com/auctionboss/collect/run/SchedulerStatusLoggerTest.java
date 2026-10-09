package com.auctionboss.collect.run;

import static org.assertj.core.api.Assertions.assertThat;

import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.read.ListAppender;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.slf4j.LoggerFactory;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;

/** 스펙 "기본 설정으로 기동": 기동 로그에 두 워커가 꺼져 있다고 남는다. */
class SchedulerStatusLoggerTest {

	private final ListAppender<ILoggingEvent> logs = new ListAppender<>();

	private final ApplicationContextRunner runner = new ApplicationContextRunner()
		.withUserConfiguration(SchedulerStatusLogger.class);

	@BeforeEach
	void attach() {
		logs.start();
		((Logger) LoggerFactory.getLogger(SchedulerStatusLogger.class)).addAppender(logs);
	}

	@AfterEach
	void detach() {
		((Logger) LoggerFactory.getLogger(SchedulerStatusLogger.class)).detachAppender(logs);
	}

	@Test
	void 설정이_없으면_두_워커와_외부_요청_허용이_꺼져_있다고_남긴다() {
		runner.run(context -> assertThat(logs.list).extracting(ILoggingEvent::getFormattedMessage)
			.containsExactly("[scheduler] 수집 워커 꺼짐, 사진 워커 꺼짐, 외부 요청 허용 꺼짐"));
	}

	@Test
	void 켠_설정은_켜짐으로_남긴다() {
		runner
			.withPropertyValues("auctionboss.collector.enabled=true", "auctionboss.source.external-requests-allowed=true")
			.run(context -> assertThat(logs.list).extracting(ILoggingEvent::getFormattedMessage)
				.containsExactly("[scheduler] 수집 워커 켜짐, 사진 워커 꺼짐, 외부 요청 허용 켜짐"));
	}

}
