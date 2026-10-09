package com.auctionboss.collect.run;

import static org.assertj.core.api.Assertions.assertThat;

import java.time.Duration;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.CyclicBarrier;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import com.auctionboss.support.MySqlTestContainer;
import com.zaxxer.hikari.HikariConfig;
import com.zaxxer.hikari.HikariDataSource;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

/**
 * 5.3: 같은 MySQL을 쓰는 인스턴스 둘(각자 연결 풀, 각자 {@link RunLock}·{@link WorkerTicker})이 같은 시각에 틱해도 회차는 하나만
 * 돌고 다른 쪽은 {@code overlap} 건너뜀이다. 풀은 인스턴스마다 2개로 줄여(테스트 전용) MySQL 연결 한도를 아낀다.
 */
class TwoInstanceTickTest {

	private static final int REPEAT = 20;

	private final String lockName = "auctionboss.test." + UUID.randomUUID().toString().substring(0, 8);

	private HikariDataSource poolA;

	private HikariDataSource poolB;

	private static HikariDataSource pool() {
		HikariConfig config = new HikariConfig();
		config.setJdbcUrl(MySqlTestContainer.MYSQL.getJdbcUrl());
		config.setUsername(MySqlTestContainer.MYSQL.getUsername());
		config.setPassword(MySqlTestContainer.MYSQL.getPassword());
		config.setMaximumPoolSize(2);
		config.setConnectionTimeout(5_000);
		return new HikariDataSource(config);
	}

	@BeforeEach
	void open() {
		poolA = pool();
		poolB = pool();
	}

	@AfterEach
	void close() {
		poolA.close();
		poolB.close();
	}

	@Test
	void 같은_시각_틱을_20회_반복해도_동시_회차는_하나이고_나머지는_overlap이다() throws Exception {
		AtomicInteger inFlight = new AtomicInteger();
		AtomicInteger maxInFlight = new AtomicInteger();
		AtomicInteger roundsStarted = new AtomicInteger();
		List<String> skips = new CopyOnWriteArrayList<>();
		// 한 반복 안에서 두 틱이 모두 끝날 때까지 이긴 쪽 회차를 붙잡아 둔다: 진 쪽의 잠금 시도가 반드시 이긴 쪽이 쥐고 있는 동안 일어난다.
		CountDownLatch[] bothTicked = { new CountDownLatch(2) };

		Runnable round = () -> {
			int now = inFlight.incrementAndGet();
			maxInFlight.accumulateAndGet(now, Math::max);
			roundsStarted.incrementAndGet();
			try {
				bothTicked[0].await(10, TimeUnit.SECONDS);
			}
			catch (InterruptedException e) {
				Thread.currentThread().interrupt();
			}
			finally {
				inFlight.decrementAndGet();
			}
		};
		WorkerTicker a = new WorkerTicker("a", lockName, new RunLock(poolA), () -> 0, skips::add, round);
		WorkerTicker b = new WorkerTicker("b", lockName, new RunLock(poolB), () -> 0, skips::add, round);
		try {
			for (int i = 0; i < REPEAT; i++) {
				bothTicked[0] = new CountDownLatch(2);
				skips.clear();
				roundsStarted.set(0);
				CyclicBarrier gate = new CyclicBarrier(2);
				Thread ta = new Thread(() -> tickTogether(a, gate, bothTicked[0]));
				Thread tb = new Thread(() -> tickTogether(b, gate, bothTicked[0]));
				ta.start();
				tb.start();
				ta.join(15_000);
				tb.join(15_000);
				assertThat(a.awaitIdle(Duration.ofSeconds(15))).isTrue();
				assertThat(b.awaitIdle(Duration.ofSeconds(15))).isTrue();

				assertThat(roundsStarted.get()).as("반복 %d: 시작된 회차", i).isEqualTo(1);
				assertThat(skips).as("반복 %d: 건너뜀", i).containsExactly("overlap");
			}
			assertThat(maxInFlight.get()).as("동시에 돈 회차의 최대치").isEqualTo(1);
		}
		finally {
			a.shutdown(Duration.ofSeconds(1));
			b.shutdown(Duration.ofSeconds(1));
		}
	}

	private static void tickTogether(WorkerTicker ticker, CyclicBarrier gate, CountDownLatch done) {
		try {
			gate.await(10, TimeUnit.SECONDS);
			ticker.tick();
		}
		catch (Exception e) {
			throw new IllegalStateException(e);
		}
		finally {
			done.countDown();
		}
	}

}
