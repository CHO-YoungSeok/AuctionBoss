package com.auctionboss.common.seed;

import org.junit.jupiter.api.AfterEach;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Import;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;

import com.auctionboss.support.MySqlTestContainer;

/**
 * seed 프로필로 기동하는 테스트의 베이스. 공용 컨테이너를 쓰므로 테스트가 끝나면 반드시 비운다.
 * 시작 시점에는 비우지 않는다: 기동 직후 적재 결과를 그대로 볼 수 있어야 하는 테스트가 있기 때문이다.
 */
@SpringBootTest
@ActiveProfiles({ "test", "seed" })
@Import(MySqlTestContainer.class)
abstract class AbstractSeedTest {

	@Autowired
	protected JdbcTemplate jdbc;

	protected long count(String table) {
		return jdbc.queryForObject("SELECT COUNT(*) FROM " + table, Long.class);
	}

	protected void clearAll() {
		jdbc.update("DELETE FROM items");
		jdbc.update("DELETE FROM worker_runs");
		jdbc.update("DELETE FROM collector_state");
		jdbc.update("DELETE FROM feed_reads");
	}

	@AfterEach
	void cleanAfter() {
		clearAll();
	}

}
