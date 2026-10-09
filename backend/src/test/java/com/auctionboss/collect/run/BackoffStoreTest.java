package com.auctionboss.collect.run;

import static org.assertj.core.api.Assertions.assertThat;

import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;

import com.auctionboss.support.AbstractMySqlTest;
import com.auctionboss.support.FixedClockConfig;
import com.auctionboss.support.MutableClock;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.context.annotation.Import;

/** 4.3: 공유 백오프. 한 문장 연장, 짧아지지 않음, TS가 쓴 형식 읽기, 동시 연장. */
@Import(FixedClockConfig.class)
class BackoffStoreTest extends AbstractMySqlTest {

	private static final Instant T0 = Instant.parse("2026-10-08T00:00:00Z");

	@Autowired
	BackoffStore store;

	@Autowired
	MutableClock clock;

	@BeforeEach
	void resetClock() {
		clock.set(T0);
	}

	private Map<String, Object> row() {
		return jdbc.queryForMap(
				"SELECT value, DATE_FORMAT(updated_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS updated_at FROM collector_state WHERE `key` = 'backoff_until'");
	}

	private void putRaw(String value) {
		jdbc.update("INSERT INTO collector_state (`key`, value, updated_at) VALUES ('backoff_until', ?, '2026-01-01 00:00:00.000')",
				value);
	}

	@Test
	void 값이_없으면_백오프_없음이다() {
		assertThat(store.until()).isEmpty();
		assertThat(store.remainingMs(T0)).isZero();
	}

	@Test
	void 연장하면_ISO_밀리초_Z_형식으로_저장하고_저장_시각을_남긴다() {
		store.extend(Instant.parse("2026-10-08T01:00:00Z"));

		assertThat(row().get("value")).isEqualTo("2026-10-08T01:00:00.000Z");
		assertThat(row().get("updated_at")).isEqualTo("2026-10-08T00:00:00.000000Z");
		assertThat(store.until()).contains(Instant.parse("2026-10-08T01:00:00Z"));
		assertThat(store.remainingMs(T0)).isEqualTo(3_600_000);
		assertThat(store.remainingMs(Instant.parse("2026-10-08T01:00:00Z"))).isZero();
	}

	@Test
	void 더_이른_시각으로는_짧아지지_않고_저장_시각도_바뀌지_않는다() {
		store.extend(Instant.parse("2026-10-08T02:00:00Z"));
		clock.set(T0.plusSeconds(600));

		store.extend(Instant.parse("2026-10-08T01:00:00Z"));

		assertThat(row().get("value")).isEqualTo("2026-10-08T02:00:00.000Z");
		assertThat(row().get("updated_at")).isEqualTo("2026-10-08T00:00:00.000000Z");
	}

	@Test
	void 같은_시각으로_다시_연장해도_저장_시각은_그대로이다() {
		store.extend(Instant.parse("2026-10-08T02:00:00Z"));
		clock.set(T0.plusSeconds(600));

		store.extend(Instant.parse("2026-10-08T02:00:00Z"));

		assertThat(row().get("updated_at")).isEqualTo("2026-10-08T00:00:00.000000Z");
	}

	@Test
	void 더_늦은_시각이면_값과_저장_시각이_함께_바뀐다() {
		store.extend(Instant.parse("2026-10-08T01:00:00Z"));
		clock.set(T0.plusSeconds(600));

		store.extend(Instant.parse("2026-10-08T03:00:00Z"));

		assertThat(row().get("value")).isEqualTo("2026-10-08T03:00:00.000Z");
		assertThat(row().get("updated_at")).isEqualTo("2026-10-08T00:10:00.000000Z");
	}

	@Test
	void TS가_쓴_형식을_읽고_그_값_뒤에도_연장한다() {
		putRaw("2026-10-08T05:00:00.123Z");

		assertThat(store.until()).contains(Instant.parse("2026-10-08T05:00:00.123Z"));

		store.extend(Instant.parse("2026-10-08T05:00:00.122Z"));
		assertThat(row().get("value")).isEqualTo("2026-10-08T05:00:00.123Z");
		store.extend(Instant.parse("2026-10-08T05:00:00.124Z"));
		assertThat(row().get("value")).isEqualTo("2026-10-08T05:00:00.124Z");
	}

	@Test
	void 밀리초_없는_ISO_값도_읽고_비교한다() {
		putRaw("2026-10-08T05:00:00Z");

		assertThat(store.until()).contains(Instant.parse("2026-10-08T05:00:00Z"));
		store.extend(Instant.parse("2026-10-08T04:00:00Z"));
		assertThat(row().get("value")).isEqualTo("2026-10-08T05:00:00Z");
	}

	@Test
	void 읽을_수_없는_값은_없음으로_보고_새_값으로_덮는다() {
		for (String garbage : List.of("", "내일", "2026-13-45T99:00:00.000Z", "null")) {
			jdbc.update("DELETE FROM collector_state");
			putRaw(garbage);

			assertThat(store.until()).as(garbage).isEmpty();
			assertThat(store.remainingMs(T0)).isZero();

			store.extend(Instant.parse("2026-10-08T01:00:00Z"));
			assertThat(row().get("value")).as(garbage).isEqualTo("2026-10-08T01:00:00.000Z");
		}
	}

	@Test
	void 두_스레드가_동시에_연장해도_늦은_값이_남는다() throws Exception {
		int rounds = 30;
		ExecutorService pool = Executors.newFixedThreadPool(2);
		try {
			for (int r = 0; r < rounds; r++) {
				int round = r;
				jdbc.update("DELETE FROM collector_state");
				Instant early = Instant.parse("2026-10-08T01:00:00Z");
				Instant late = Instant.parse("2026-10-08T03:00:00Z");
				CountDownLatch start = new CountDownLatch(1);
				// 번갈아 가며 늦은 값을 먼저/나중에 넣어 두 순서를 모두 겪는다.
				Future<?> a = pool.submit(() -> {
					start.await();
					store.extend(round % 2 == 0 ? early : late);
					return null;
				});
				Future<?> b = pool.submit(() -> {
					start.await();
					store.extend(round % 2 == 0 ? late : early);
					return null;
				});
				start.countDown();
				a.get();
				b.get();
				assertThat(store.until()).as("round " + round).contains(late);
			}
		}
		finally {
			pool.shutdownNow();
		}
	}

}
