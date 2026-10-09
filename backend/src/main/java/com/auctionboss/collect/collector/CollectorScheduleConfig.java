package com.auctionboss.collect.collector;

import com.auctionboss.collect.run.BackoffStore;
import com.auctionboss.collect.run.CollectorSettings;
import com.auctionboss.collect.run.RunLock;
import com.auctionboss.collect.run.WorkerSchedule;
import com.auctionboss.collect.run.WorkerTicker;
import com.auctionboss.common.time.ServerClock;
import com.auctionboss.worker.WorkerRunService;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/**
 * 수집 워커의 틱 등록(design D4 첫 번째 잠금). {@code auctionboss.collector.enabled=true}를 명시해야만 빈이 생긴다(기본 꺼짐, 켜는
 * 값이 없으면 빈 자체가 없다). 틱 본체는 {@code collect.run}의 일반 {@link WorkerTicker}이고 여기서 수집 회차를 주입한다.
 */
@Configuration(proxyBeanMethods = false)
@ConditionalOnProperty(name = "auctionboss.collector.enabled", havingValue = "true")
class CollectorScheduleConfig {

	static final String WORKER = CollectorRun.WORKER;

	static final String LOCK_NAME = CollectorRun.LOCK_NAME;

	@Bean
	WorkerSchedule collectorSchedule(CollectorRun run, RunLock lock, BackoffStore backoff, WorkerRunService runs,
			ServerClock clock, CollectorSettings settings,
			@Value("${auctionboss.collector.run-immediately:true}") boolean runImmediately) {
		WorkerTicker ticker = new WorkerTicker(WORKER, LOCK_NAME, lock, () -> backoff.remainingMs(clock.now()),
				reason -> runs.recordSkipped(WORKER, reason), run::run);
		return new WorkerSchedule(ticker, settings.intervalMs(), runImmediately);
	}

}
