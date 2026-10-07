package com.auctionboss.common.seed;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.test.context.TestPropertySource;

/**
 * 스펙 "개발 환경 기동": 빈 DB로 기동하면 로더가 시드를 적재한다.
 * 전용 속성으로 별도 컨텍스트를 만들어, 다른 테스트가 먼저 컨텍스트를 만들고 비워도
 * 이 컨텍스트의 "기동 시점"이 항상 새로 일어나게 한다(실행 순서 무관).
 */
@TestPropertySource(properties = "auctionboss.test.context=seed-startup")
class SeedLoaderStartupTest extends AbstractSeedTest {

	@Autowired
	private SeedLoader loader;

	@Test
	void 기동하면_시드가_적재되고_원본_id로_조회된다() {
		assertThat(count("items")).isEqualTo(809);
		assertThat(count("item_changes")).isEqualTo(4008);
		assertThat(count("analyses")).isEqualTo(12);
		assertThat(count("worker_runs")).isEqualTo(7);
		assertThat(count("collector_state")).isEqualTo(1);
		assertThat(jdbc.queryForObject("SELECT case_no FROM items WHERE id = 53", String.class))
				.isEqualTo("2025타경1833");
		assertThat(jdbc.queryForObject("SELECT appraisal_price FROM items WHERE id = 53", Long.class))
				.isEqualTo(51_005_255_120L);
		assertThat(loader).isNotNull();
	}

}
