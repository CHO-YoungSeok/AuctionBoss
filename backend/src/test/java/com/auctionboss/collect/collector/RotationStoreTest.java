package com.auctionboss.collect.collector;

import static org.assertj.core.api.Assertions.assertThat;

import com.auctionboss.support.AbstractMySqlTest;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.JdbcTemplate;

class RotationStoreTest extends AbstractMySqlTest {

	@Autowired
	RotationStore rotation;

	@Autowired
	JdbcTemplate jdbc;

	private void raw(String value) {
		jdbc.update("DELETE FROM collector_state WHERE `key` = ?", RotationStore.FAILURE_KEY);
		jdbc.update("INSERT INTO collector_state (`key`, value, updated_at) VALUES (?, ?, NOW())",
				RotationStore.FAILURE_KEY, value);
	}

	@Test
	void 값이_없으면_0이다() {
		rotation.clearFailures();
		assertThat(rotation.failureCount("B000210")).isZero();
	}

	@Test
	void 정상_값은_같은_법원에서만_횟수로_읽힌다() {
		raw("B000210|2");
		assertThat(rotation.failureCount("B000210")).isEqualTo(2);
		assertThat(rotation.failureCount("B000211")).isZero();
	}

	@Test
	void 깨진_값은_0이다() {
		for (String bad : new String[] { "B000210|abc", "garbage", "B000210|", "|3", "B000210|1|2" }) {
			raw(bad);
			assertThat(rotation.failureCount("B000210")).as(bad).isZero();
		}
	}

	@Test
	void 깨진_값_위에_기록하면_1부터_다시_센다() {
		raw("garbage");
		assertThat(rotation.recordFailure("B000210")).isEqualTo(1);
		assertThat(rotation.recordFailure("B000210")).isEqualTo(2);
	}

}
