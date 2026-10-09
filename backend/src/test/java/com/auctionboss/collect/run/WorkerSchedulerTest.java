package com.auctionboss.collect.run;

import static org.assertj.core.api.Assertions.assertThat;

import java.time.Duration;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import ch.qos.logback.classic.Level;
import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.read.ListAppender;
import com.auctionboss.support.Eventually;
import com.auctionboss.support.LockTestDataSources;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.slf4j.LoggerFactory;
import org.springframework.scheduling.concurrent.ThreadPoolTaskScheduler;

/** 5.4(켜질 때 경고·등록)와 5.7(애플리케이션 종료 시 진행 중 회차 대기) 중 스케줄러 수명주기 쪽. */
class WorkerSchedulerTest {

	private static final Duration LONG = Duration.ofSeconds(10);

	private final String lockName = "auctionboss.test." + UUID.randomUUID().toString().substring(0, 8);

	private final RunLock lock = new RunLock(new LockTestDataSources.Recording());

	private final AtomicInteger started = new AtomicInteger();

	private final List<String> skips = new CopyOnWriteArrayList<>();

	private final ListAppender<ILoggingEvent> logs = new ListAppender<>();

	private ThreadPoolTaskScheduler taskScheduler;

	@BeforeEach
	void setUp() {
		logs.start();
		((Logger) LoggerFactory.getLogger(WorkerScheduler.class)).addAppender(logs);
		((Logger) LoggerFactory.getLogger(WorkerTicker.class)).addAppender(logs);
		taskScheduler = new ThreadPoolTaskScheduler();
		taskScheduler.setPoolSize(1);
		taskScheduler.initialize();
	}

	@AfterEach
	void tearDown() {
		((Logger) LoggerFactory.getLogger(WorkerScheduler.class)).detachAppender(logs);
		((Logger) LoggerFactory.getLogger(WorkerTicker.class)).detachAppender(logs);
		taskScheduler.shutdown();
	}

	private WorkerTicker ticker(Runnable round) {
		return new WorkerTicker("test", lockName, lock, () -> 0, skips::add, round);
	}

	@Test
	void 시작하면_설정한_주기로_틱을_등록하고_기존_수집기를_멈추라는_경고를_남긴다() {
		WorkerScheduler scheduler = new WorkerScheduler(taskScheduler,
				List.of(new WorkerSchedule(ticker(started::incrementAndGet), 20, true)), Duration.ofSeconds(5));

		scheduler.start();
		try {
			assertThat(scheduler.isRunning()).isTrue();
			assertThat(Eventually.until(LONG, () -> started.get() >= 3)).as("주기마다 회차가 돈다").isTrue();
			assertThat(logs.list).anyMatch(e -> e.getLevel() == Level.WARN && e.getFormattedMessage().contains("TS"));
			assertThat(logs.list).anyMatch(e -> e.getFormattedMessage().contains("주기 20ms"));
		}
		finally {
			scheduler.stop();
		}
	}

	@Test
	void 기동_직후_실행을_끄면_첫_틱은_한_주기_뒤다() throws Exception {
		WorkerScheduler scheduler = new WorkerScheduler(taskScheduler,
				List.of(new WorkerSchedule(ticker(started::incrementAndGet), 600_000, false)), Duration.ofSeconds(5));

		scheduler.start();
		try {
			Thread.sleep(200);
			assertThat(started.get()).isZero();
		}
		finally {
			scheduler.stop();
		}
	}

	@Test
	void 종료하면_스케줄러를_멈추고_진행_중_회차를_기다린_뒤_잠금을_푼다() {
		CountDownLatch release = new CountDownLatch(1);
		AtomicInteger finished = new AtomicInteger();
		WorkerTicker ticker = ticker(() -> {
			started.incrementAndGet();
			try {
				release.await(30, TimeUnit.SECONDS);
			}
			catch (InterruptedException e) {
				Thread.currentThread().interrupt();
			}
			finished.incrementAndGet();
		});
		WorkerScheduler scheduler = new WorkerScheduler(taskScheduler, List.of(new WorkerSchedule(ticker, 20, true)),
				LONG);
		scheduler.start();
		assertThat(Eventually.until(LONG, () -> started.get() == 1)).isTrue();
		new Thread(() -> {
			try {
				Thread.sleep(100);
			}
			catch (InterruptedException e) {
				Thread.currentThread().interrupt();
			}
			release.countDown();
		}).start();

		scheduler.stop();

		assertThat(scheduler.isRunning()).isFalse();
		assertThat(finished.get()).as("진행 중이던 회차를 기다렸다").isEqualTo(1);
		assertThat(lock.tryAcquire(lockName)).as("잠금이 풀렸다").isPresent().get().satisfies(RunLock.Held::close);
		int after = started.get();
		assertThat(Eventually.until(Duration.ofMillis(200), () -> started.get() > after)).as("멈춘 뒤 새 회차 없음").isFalse();
	}

	@Test
	void 대기_상한을_넘기면_로그를_남기고_끝난다() {
		CountDownLatch never = new CountDownLatch(1);
		WorkerTicker ticker = ticker(() -> {
			started.incrementAndGet();
			try {
				never.await(30, TimeUnit.SECONDS);
			}
			catch (InterruptedException e) {
				Thread.currentThread().interrupt();
			}
		});
		WorkerScheduler scheduler = new WorkerScheduler(taskScheduler, List.of(new WorkerSchedule(ticker, 20, true)),
				Duration.ofMillis(100));
		scheduler.start();
		assertThat(Eventually.until(LONG, () -> started.get() == 1)).isTrue();

		scheduler.stop();

		assertThat(scheduler.isRunning()).isFalse();
		assertThat(logs.list).anyMatch(e -> e.getLevel() == Level.WARN && e.getFormattedMessage().contains("종료 대기 상한"));
		assertThat(Eventually.until(LONG, () -> lock.tryAcquire(lockName).map(h -> {
			h.close();
			return true;
		}).orElse(false))).isTrue();
	}

}
