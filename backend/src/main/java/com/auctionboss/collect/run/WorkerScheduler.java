package com.auctionboss.collect.run;

import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.atomic.AtomicBoolean;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.context.SmartLifecycle;
import org.springframework.scheduling.TaskScheduler;

/**
 * 워커 틱을 고정 주기로 등록하고(기동), 종료 때 스케줄러를 먼저 멈춘 뒤 진행 중 회차를 기다린다(TS {@code stop()}과 같음. 기다리는
 * 상한은 {@code auctionboss.workers.shutdown-wait-ms}). 켜질 때 기존(TS) 수집기·사진 워커가 멈춰 있어야 한다는 경고를 남긴다(D14).
 */
public class WorkerScheduler implements SmartLifecycle {

	private static final Logger log = LoggerFactory.getLogger(WorkerScheduler.class);

	private final TaskScheduler scheduler;

	private final List<WorkerSchedule> schedules;

	private final Duration shutdownWait;

	private final List<ScheduledFuture<?>> futures = new ArrayList<>();

	private final AtomicBoolean running = new AtomicBoolean();

	public WorkerScheduler(TaskScheduler scheduler, List<WorkerSchedule> schedules, Duration shutdownWait) {
		this.scheduler = scheduler;
		this.schedules = List.copyOf(schedules);
		this.shutdownWait = shutdownWait;
	}

	@Override
	public void start() {
		if (!running.compareAndSet(false, true)) {
			return;
		}
		log.warn("[scheduler] 백엔드 수집 스케줄러가 켜집니다. 기존(TS) 수집기·사진 워커가 같은 소스에 요청하고 있으면 안 됩니다"
				+ " - 서로의 백오프를 보지 못하고 요청 예산을 두 배로 씁니다(런북 확인)");
		for (WorkerSchedule schedule : schedules) {
			Duration period = Duration.ofMillis(schedule.intervalMs());
			Instant first = schedule.runImmediately() ? Instant.now() : Instant.now().plus(period);
			futures.add(scheduler.scheduleAtFixedRate(schedule.ticker()::tick, first, period));
			log.info("[scheduler] {} 틱 등록 - 주기 {}ms, 기동 직후 실행 {}", schedule.ticker().worker(), schedule.intervalMs(),
					schedule.runImmediately());
		}
	}

	@Override
	public void stop() {
		if (!running.compareAndSet(true, false)) {
			return;
		}
		futures.forEach(future -> future.cancel(false));
		futures.clear();
		for (WorkerSchedule schedule : schedules) {
			schedule.ticker().shutdown(shutdownWait);
		}
	}

	@Override
	public boolean isRunning() {
		return running.get();
	}

}
