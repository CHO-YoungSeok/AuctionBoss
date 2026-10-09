package com.auctionboss.collect.collector;

import static org.assertj.core.api.Assertions.assertThat;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;

import com.auctionboss.collect.source.SourceItem;
import com.auctionboss.support.AbstractMySqlTest;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;

/** 3.3: 법원 1곳 규모(500건) 배치의 저장 시간. 시드 위 갱신이 1초를 넘으면 JDBC 배치로 바꾼다(design D8). */
class ItemUpsertTimingTest extends AbstractMySqlTest {

	private static final Instant T0 = Instant.parse("2026-10-08T00:00:00.000Z");

	/** 환경이 느려도 흔들리지 않게 둔 느슨한 상한. 설계 기준(1초)은 메모의 측정값으로 본다. */
	private static final long LOOSE_LIMIT_MS = 3000;

	@Autowired
	ItemUpsertService service;

	private static List<SourceItem> batch(int size, long priceOffset, boolean withNewTail) {
		List<SourceItem> items = new ArrayList<>();
		for (int i = 0; i < size; i++) {
			// 절반은 최저가·유찰이 바뀌고 나머지는 그대로
			boolean moved = priceOffset != 0 && i % 2 == 0;
			items.add(TestItems.item("2026타경" + (10000 + i), 240_000_000L - (moved ? priceOffset : 0),
					moved ? 1L : 0L, "2026-11-05", moved ? "유찰 1회" : "신건"));
		}
		if (withNewTail) {
			for (int i = 0; i < 50; i++) {
				items.add(TestItems.item("2026타경" + (90000 + i), 100_000_000L, 0L, "2026-11-05", "신건"));
			}
		}
		return items;
	}

	@Test
	void 오백건_배치_저장_시간을_잰다() {
		long first = timed(() -> service.upsertItems(batch(500, 0, false), T0));
		List<Long> updates = new ArrayList<>();
		for (int round = 1; round <= 5; round++) {
			int r = round;
			updates.add(timed(() -> service.upsertItems(batch(500, 48_000_000L * r, r == 1), T0.plusSeconds(60L * r))));
		}
		System.out.println("[3.3 저장 시간] 500건 신규 " + first + "ms, 시드 위 갱신(절반 변경) " + updates + "ms");

		assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM items", Integer.class)).isEqualTo(550);
		// 첫 배치는 콜드 상태(커넥션·JIT·버퍼 풀)라 전체 테스트 부하에 따라 4~5초까지 흔들린다(회귀 검증 실측).
		// 그래서 첫 배치는 기록만 하고, 예열 뒤 갱신의 중앙값과 최솟값으로 성능 회귀를 막는다.
		List<Long> sorted = updates.stream().sorted().toList();
		assertThat(sorted.get(sorted.size() / 2)).isLessThan(LOOSE_LIMIT_MS);
		assertThat(sorted.get(0)).isLessThan(LOOSE_LIMIT_MS / 2);
	}

	private static long timed(Runnable r) {
		long start = System.nanoTime();
		r.run();
		return (System.nanoTime() - start) / 1_000_000;
	}

}
