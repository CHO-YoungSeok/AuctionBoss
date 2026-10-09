package com.auctionboss.collect.run;

import java.time.Duration;

import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.condition.ConditionalOnExpression;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.scheduling.concurrent.ThreadPoolTaskScheduler;

/**
 * 주기 실행 설정(design D4, D7). 수집·사진 중 하나라도 켜져 있을 때만 존재한다: 둘 다 꺼져 있으면(기본) 스케줄러 스레드도, 틱 등록도
 * 없다. 틱 대상({@link WorkerSchedule})은 워커별 설정 클래스가 각자의 켜는 설정 아래에서 내놓는다.
 *
 * <p>
 * {@code @EnableScheduling}과 {@code @Scheduled}는 쓰지 않는다: 틱 등록은 {@link WorkerScheduler}가 직접 하므로 애너테이션 처리기가
 * 필요 없고, 꺼져 있을 때 스케줄링 인프라가 만들어질 여지도 없다.
 */
@Configuration(proxyBeanMethods = false)
@ConditionalOnExpression("${auctionboss.collector.enabled:false} or ${auctionboss.photos.enabled:false}")
public class SchedulingConfig {

	@Bean
	ThreadPoolTaskScheduler workerTickScheduler(ObjectProvider<WorkerSchedule> schedules) {
		// 틱은 짧게 끝나므로 워커마다 스레드 하나면 충분하다.
		ThreadPoolTaskScheduler scheduler = new ThreadPoolTaskScheduler();
		scheduler.setPoolSize(Math.max(1, (int) schedules.orderedStream().count()));
		scheduler.setThreadNamePrefix("auctionboss-tick-");
		return scheduler;
	}

	@Bean
	WorkerScheduler workerScheduler(ThreadPoolTaskScheduler workerTickScheduler, ObjectProvider<WorkerSchedule> schedules,
			@Value("${auctionboss.workers.shutdown-wait-ms:30000}") long shutdownWaitMs) {
		return new WorkerScheduler(workerTickScheduler, schedules.orderedStream().toList(), Duration.ofMillis(shutdownWaitMs));
	}

}
