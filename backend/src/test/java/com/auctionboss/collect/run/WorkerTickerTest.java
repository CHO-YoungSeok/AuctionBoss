package com.auctionboss.collect.run;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;

import java.sql.SQLException;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;

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

/**
 * 5.2, 5.7: 워커 틱. 시간 의존은 래치와 짧은 주기로 결정적으로 만든다(대기는 상한일 뿐, 정상 경로는 곧바로 끝난다).
 */
class WorkerTickerTest {

	private static final Duration LONG = Duration.ofSeconds(10);

	private final String lockName = "auctionboss.test." + UUID.randomUUID().toString().substring(0, 8);

	private final RunLock lock = new RunLock(new LockTestDataSources.Recording());

	private final List<String> skips = new CopyOnWriteArrayList<>();

	private final AtomicInteger started = new AtomicInteger();

	private final AtomicLong backoffMs = new AtomicLong();

	private final ListAppender<ILoggingEvent> logs = new ListAppender<>();

	private WorkerTicker ticker;

	private ThreadPoolTaskScheduler scheduler;

	@BeforeEach
	void attachLog() {
		logs.start();
		((Logger) LoggerFactory.getLogger(WorkerTicker.class)).addAppender(logs);
	}

	@AfterEach
	void cleanUp() {
		((Logger) LoggerFactory.getLogger(WorkerTicker.class)).detachAppender(logs);
		if (scheduler != null) {
			scheduler.shutdown();
		}
		if (ticker != null) {
			ticker.shutdown(Duration.ofSeconds(1));
		}
	}

	private WorkerTicker ticker(Runnable round) {
		ticker = new WorkerTicker("test", lockName, lock, backoffMs::get, skips::add, round);
		return ticker;
	}

	private boolean lockIsFree() {
		return lock.tryAcquire(lockName).map(held -> {
			held.close();
			return true;
		}).orElse(false);
	}

	@Test
	void 회차가_주기보다_길면_그_사이_틱은_overlap으로_기록되고_끝난_뒤_몰아서_실행되지_않는다() throws Exception {
		CountDownLatch release = new CountDownLatch(1);
		ticker(() -> {
			// 첫 회차만 오래 걸린다.
			if (started.incrementAndGet() == 1) {
				await(release);
			}
		});
		scheduler = new ThreadPoolTaskScheduler();
		scheduler.setPoolSize(1); // 틱 스레드가 하나뿐이라, 회차를 틱 스레드에서 돌리면 틱 자체가 멈춘다.
		scheduler.initialize();
		ScheduledFuture<?> future = scheduler.scheduleAtFixedRate(ticker::tick, Instant.now(), Duration.ofMillis(20));

		try {
			boolean skipped = Eventually.until(LONG, () -> skips.size() >= 3);
			assertThat(skipped).as("긴 회차 동안 도래한 주기가 건너뜀으로 기록된다").isTrue();
			assertThat(started.get()).as("건너뛴 주기마다 회차가 새로 시작되지 않는다").isEqualTo(1);
			assertThat(skips).allMatch("overlap"::equals);
		}
		finally {
			release.countDown();
		}
		// 회차가 끝나면 그 뒤 주기는 정상적으로 새 회차를 시작한다. 밀린 주기를 한꺼번에 따라잡지는 않는다
		// (건너뛴 주기는 이미 건너뜀 행으로 끝났다).
		assertThat(Eventually.until(LONG, () -> started.get() >= 2)).isTrue();
		future.cancel(false);
		assertThat(ticker.awaitIdle(LONG)).isTrue();
		assertThat(lockIsFree()).isTrue();
	}

	@Test
	void 실패한_회차_뒤_다음_틱은_정상으로_시작한다() {
		ticker(() -> {
			if (started.incrementAndGet() == 1) {
				throw new IllegalStateException("응답 형식 오류");
			}
		});

		ticker.tick();
		assertThat(ticker.awaitIdle(LONG)).isTrue();
		assertThat(lockIsFree()).as("실패해도 잠금은 풀린다").isTrue();
		ticker.tick();
		assertThat(ticker.awaitIdle(LONG)).isTrue();

		assertThat(started.get()).isEqualTo(2);
		assertThat(skips).isEmpty();
	}

	@Test
	void 백오프가_남았으면_backoff로_기록하고_회차를_시작하지_않으며_잠금을_푼다() {
		ticker(started::incrementAndGet);
		backoffMs.set(5_000);

		ticker.tick();

		assertThat(skips).containsExactly("backoff");
		assertThat(started.get()).isZero();
		assertThat(lockIsFree()).as("백오프를 확인한 뒤 잠금을 풀었다").isTrue();

		backoffMs.set(0);
		ticker.tick();
		assertThat(ticker.awaitIdle(LONG)).isTrue();
		assertThat(started.get()).isEqualTo(1);
	}

	@Test
	void 겹침을_백오프보다_먼저_본다() {
		CountDownLatch release = new CountDownLatch(1);
		ticker(() -> {
			started.incrementAndGet();
			await(release);
		});
		ticker.tick();
		assertThat(Eventually.until(LONG, () -> started.get() == 1)).isTrue();

		backoffMs.set(5_000);
		ticker.tick();

		assertThat(skips).containsExactly("overlap");
		release.countDown();
		assertThat(ticker.awaitIdle(LONG)).isTrue();
	}

	@Test
	void 틱은_어떤_오류도_밖으로_던지지_않는다() {
		RunLock broken = new RunLock(new org.springframework.jdbc.datasource.AbstractDataSource() {
			@Override
			public java.sql.Connection getConnection() throws SQLException {
				throw new SQLException("연결 불가");
			}

			@Override
			public java.sql.Connection getConnection(String u, String p) throws SQLException {
				throw new SQLException("연결 불가");
			}
		});
		WorkerTicker noDb = new WorkerTicker("test", lockName, broken, () -> 0, skips::add, started::incrementAndGet);
		WorkerTicker failingRecorder = new WorkerTicker("test", lockName, lock, () -> 0, reason -> {
			throw new IllegalStateException("기록 실패");
		}, started::incrementAndGet);
		ticker = failingRecorder;

		assertThatCode(noDb::tick).doesNotThrowAnyException();
		assertThat(skips).isEmpty();
		assertThat(started.get()).isZero();

		// 건너뜀 기록이 실패해도 틱은 죽지 않는다.
		RunLock.Held held = lock.tryAcquire(lockName).orElseThrow();
		assertThatCode(failingRecorder::tick).doesNotThrowAnyException();
		held.close();
		noDb.shutdown(Duration.ofSeconds(1));
	}

	@Test
	void 종료는_진행_중인_회차를_기다리고_잠금을_푼다() throws Exception {
		CountDownLatch release = new CountDownLatch(1);
		AtomicBoolean finished = new AtomicBoolean();
		ticker(() -> {
			started.incrementAndGet();
			await(release);
			finished.set(true);
		});
		ticker.tick();
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

		boolean clean = ticker.shutdown(LONG);

		assertThat(clean).isTrue();
		assertThat(finished.get()).as("진행 중이던 회차가 끝까지 돌았다").isTrue();
		assertThat(lockIsFree()).isTrue();
		ticker.tick(); // 종료 뒤 틱은 회차를 시작하지 않는다
		assertThat(started.get()).isEqualTo(1);
	}

	@Test
	void 종료_대기_상한을_넘으면_로그를_남기고_회차를_중단시켜_끝난다() {
		CountDownLatch never = new CountDownLatch(1);
		ticker(() -> {
			started.incrementAndGet();
			await(never); // 중단(interrupt)되면 끝난다
		});
		ticker.tick();
		assertThat(Eventually.until(LONG, () -> started.get() == 1)).isTrue();

		long begin = System.nanoTime();
		boolean clean = ticker.shutdown(Duration.ofMillis(100));
		long tookMs = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - begin);

		assertThat(clean).isFalse();
		assertThat(tookMs).as("상한만 기다리고 끝난다").isLessThan(5_000);
		assertThat(logs.list).anyMatch(e -> e.getLevel() == Level.WARN && e.getFormattedMessage().contains("종료 대기 상한"));
		assertThat(Eventually.until(LONG, this::lockIsFree)).as("중단된 회차가 잠금을 풀었다").isTrue();
	}

	private static void await(CountDownLatch latch) {
		try {
			latch.await(30, TimeUnit.SECONDS);
		}
		catch (InterruptedException e) {
			Thread.currentThread().interrupt();
		}
	}

}
