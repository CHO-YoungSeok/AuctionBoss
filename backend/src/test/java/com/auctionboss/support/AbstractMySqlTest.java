package com.auctionboss.support;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Import;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;

/**
 * 공용 MySQL 컨테이너 위에서 Flyway + ddl-auto=validate로 기동하는 통합 테스트의 베이스.
 * 컨테이너를 공유하므로 각 테스트 전후로 데이터를 비운다(items 삭제는 CASCADE로 하위 행까지 지운다).
 */
@SpringBootTest
@ActiveProfiles("test")
@Import(MySqlTestContainer.class)
public abstract class AbstractMySqlTest {

	@Autowired
	protected JdbcTemplate jdbc;

	@BeforeEach
	@AfterEach
	void cleanDatabase() {
		jdbc.update("DELETE FROM items");
		jdbc.update("DELETE FROM worker_runs");
		jdbc.update("DELETE FROM collector_state");
		jdbc.update("DELETE FROM feed_reads");
	}

}
