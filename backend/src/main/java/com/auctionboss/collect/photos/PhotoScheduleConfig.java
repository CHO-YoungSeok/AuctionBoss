package com.auctionboss.collect.photos;

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
 * 사진 워커의 틱 등록(design D4 첫 번째 잠금). {@code auctionboss.photos.enabled=true}를 명시해야만 빈이 생긴다(기본 꺼짐, 켜는 값이
 * 없으면 빈 자체가 없다). 틱 본체는 수집과 같은 일반 {@link WorkerTicker}이고 여기서 사진 회차와 사진 전용 잠금 이름을 주입한다.
 */
@Configuration(proxyBeanMethods = false)
@ConditionalOnProperty(name = "auctionboss.photos.enabled", havingValue = "true")
class PhotoScheduleConfig {

	static final String WORKER = PhotoRun.WORKER;

	static final String LOCK_NAME = PhotoRun.LOCK_NAME;

	@Bean
	WorkerSchedule photosSchedule(PhotoRun run, RunLock lock, BackoffStore backoff, WorkerRunService runs,
			ServerClock clock, CollectorSettings settings,
			@Value("${auctionboss.photos.run-immediately:true}") boolean runImmediately) {
		WorkerTicker ticker = new WorkerTicker(WORKER, LOCK_NAME, lock, () -> backoff.remainingMs(clock.now()),
				reason -> runs.recordSkipped(WORKER, reason), run::run);
		return new WorkerSchedule(ticker, settings.photos().intervalMs(), runImmediately);
	}

}
