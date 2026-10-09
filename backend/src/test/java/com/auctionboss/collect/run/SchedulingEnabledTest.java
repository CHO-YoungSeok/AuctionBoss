package com.auctionboss.collect.run;

import static org.assertj.core.api.Assertions.assertThat;

import java.time.Duration;
import java.util.List;

import com.auctionboss.collect.source.AuctionSource;
import com.auctionboss.collect.source.CollectScope;
import com.auctionboss.collect.source.FetchActiveItemsResult;
import com.auctionboss.collect.source.FetchItemPhotosResult;
import com.auctionboss.collect.source.PhotoLookupRef;
import com.auctionboss.support.AbstractMySqlTest;
import com.auctionboss.support.Eventually;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.ApplicationContext;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Import;
import org.springframework.context.annotation.Primary;
import org.springframework.scheduling.concurrent.ThreadPoolTaskScheduler;
import org.springframework.test.context.TestPropertySource;

/**
 * 5.4(켜면 {@code intervalMs}로 등록): 수집만 켠다(사진은 6장). 소스는 외부 요청 없이 빈 결과를 돌려주는 가짜다. 백그라운드 틱이 다른 테스트
 * 클래스에 새지 않게 끝나면 스케줄러를 멈춘다. 컨텍스트를 닫지는 않는다: 공용 MySQL 컨테이너 빈이 컨텍스트와 함께 멈춰 이후
 * 테스트가 모두 깨진다.
 */
@Import(SchedulingEnabledTest.EmptySource.class)
@TestPropertySource(properties = { "auctionboss.collector.enabled=true",
		"auctionboss.config-path=src/test/resources/config/collector-fast.json" })
class SchedulingEnabledTest extends AbstractMySqlTest {

	@TestConfiguration(proxyBeanMethods = false)
	static class EmptySource {

		@Bean
		@Primary
		AuctionSource emptySource() {
			return new AuctionSource() {
				@Override
				public FetchActiveItemsResult fetchActiveItems(CollectScope scope) {
					return new FetchActiveItemsResult(List.of(), 1);
				}

				@Override
				public FetchItemPhotosResult fetchItemPhotos(PhotoLookupRef ref) {
					throw new UnsupportedOperationException();
				}
			};
		}

	}

	@Autowired
	ApplicationContext context;

	@Test
	void 켜면_수집_틱을_설정_파일의_주기로_등록하고_회차가_주기마다_돈다() {
		try {
			assertThat(context.getBeansOfType(WorkerSchedule.class)).hasSize(1);
			WorkerSchedule schedule = context.getBean(WorkerSchedule.class);
			assertThat(schedule.intervalMs()).isEqualTo(100);
			assertThat(schedule.ticker().worker()).isEqualTo("collector");
			assertThat(context.getBeansOfType(ThreadPoolTaskScheduler.class)).hasSize(1);
			assertThat(context.getBean(WorkerScheduler.class).isRunning()).isTrue();

			boolean ran = Eventually.until(Duration.ofSeconds(15), () -> jdbc.queryForObject(
					"SELECT COUNT(*) FROM worker_runs WHERE worker = 'collector' AND outcome = 'success'", Integer.class) >= 2);
			assertThat(ran).as("주기 100ms로 수집 회차가 반복된다").isTrue();
			assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM worker_runs WHERE worker = 'photos'", Integer.class))
				.as("사진은 켜지 않았다")
				.isZero();
		}
		finally {
			context.getBean(WorkerScheduler.class).stop();
		}
	}

}
