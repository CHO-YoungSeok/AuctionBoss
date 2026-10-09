package com.auctionboss.collect.run;

import static org.assertj.core.api.Assertions.assertThat;

import java.time.Duration;

import com.auctionboss.support.AbstractMySqlTest;
import com.auctionboss.support.Eventually;
import com.auctionboss.support.FakeSourceConfig;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.context.ApplicationContext;
import org.springframework.context.annotation.Import;
import org.springframework.scheduling.concurrent.ThreadPoolTaskScheduler;
import org.springframework.test.context.TestPropertySource;

/**
 * 6.3(사진 틱 등록): 사진만 켠다. 대기 물건이 없으므로 소스는 불리지 않고(가짜 소스도 응답이 없다) 회차는 성공 0건으로 기록된다. 끝나면
 * 스케줄러를 멈춘다(컨텍스트를 닫으면 공용 MySQL 컨테이너 빈이 멈춘다).
 */
@Import(FakeSourceConfig.class)
@TestPropertySource(properties = { "auctionboss.photos.enabled=true",
		"auctionboss.config-path=src/test/resources/config/collector-fast.json" })
class SchedulingPhotosEnabledTest extends AbstractMySqlTest {

	@Autowired
	ApplicationContext context;

	@Test
	void 켜면_사진_틱을_설정_파일의_주기와_사진_잠금_이름으로_등록하고_수집은_등록하지_않는다() {
		try {
			assertThat(context.getBeansOfType(WorkerSchedule.class)).hasSize(1);
			WorkerSchedule schedule = context.getBean(WorkerSchedule.class);
			assertThat(schedule.intervalMs()).isEqualTo(100);
			assertThat(schedule.ticker().worker()).isEqualTo("photos");
			assertThat(context.getBeansOfType(ThreadPoolTaskScheduler.class)).hasSize(1);
			assertThat(context.getBean(WorkerScheduler.class).isRunning()).isTrue();

			boolean ran = Eventually.until(Duration.ofSeconds(15), () -> jdbc.queryForObject(
					"SELECT COUNT(*) FROM worker_runs WHERE worker = 'photos' AND outcome = 'success'", Integer.class) >= 2);
			assertThat(ran).as("주기 100ms로 사진 회차가 반복된다").isTrue();
			assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM worker_runs WHERE worker = 'collector'", Integer.class))
				.as("수집은 켜지 않았다")
				.isZero();
		}
		finally {
			context.getBean(WorkerScheduler.class).stop();
		}
	}

}
