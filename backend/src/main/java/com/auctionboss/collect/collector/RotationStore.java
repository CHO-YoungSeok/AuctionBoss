package com.auctionboss.collect.collector;

import java.time.LocalDateTime;
import java.time.ZoneOffset;
import java.util.List;

import com.auctionboss.common.time.ServerClock;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

/** 로테이션 위치({@code collector_state}의 {@code collector.rotation.nextCourtCode}): 다음 회차가 시작할 법원의 코드. */
@Component
public class RotationStore {

	public static final String KEY = "collector.rotation.nextCourtCode";

	private final JdbcTemplate jdbc;

	private final ServerClock clock;

	RotationStore(JdbcTemplate jdbc, ServerClock clock) {
		this.jdbc = jdbc;
		this.clock = clock;
	}

	/** 저장된 위치. 없으면 null. */
	public String get() {
		List<String> values = jdbc.queryForList("SELECT value FROM collector_state WHERE `key` = ?", String.class,
				KEY);
		return values.isEmpty() ? null : values.get(0);
	}

	public void set(String courtCode) {
		jdbc.update("""
				INSERT INTO collector_state (`key`, value, updated_at) VALUES (?, ?, ?) AS new
				ON DUPLICATE KEY UPDATE value = new.value, updated_at = new.updated_at""", KEY, courtCode,
				LocalDateTime.ofInstant(clock.now(), ZoneOffset.UTC));
	}

	/**
	 * 연속 실패 횟수({@code collector.rotation.failure}): {@code "법원코드|횟수"}. 법원 코드가 다르면 다른 법원의 기록이므로 0으로 본다(위치가
	 * 옮겨 가면 자동으로 초기화되는 효과).
	 */
	public static final String FAILURE_KEY = "collector.rotation.failure";

	public int failureCount(String courtCode) {
		List<String> values = jdbc.queryForList("SELECT value FROM collector_state WHERE `key` = ?", String.class,
				FAILURE_KEY);
		if (values.isEmpty()) {
			return 0;
		}
		String[] parts = values.get(0).split("\\|", 2);
		if (parts.length != 2 || !parts[0].equals(courtCode)) {
			return 0;
		}
		try {
			return Integer.parseInt(parts[1]);
		}
		catch (NumberFormatException e) {
			return 0;
		}
	}

	/** 그 법원의 연속 실패를 1 늘리고 새 횟수를 돌려준다. */
	public int recordFailure(String courtCode) {
		int count = failureCount(courtCode) + 1;
		jdbc.update("""
				INSERT INTO collector_state (`key`, value, updated_at) VALUES (?, ?, ?) AS new
				ON DUPLICATE KEY UPDATE value = new.value, updated_at = new.updated_at""", FAILURE_KEY,
				courtCode + "|" + count, LocalDateTime.ofInstant(clock.now(), ZoneOffset.UTC));
		return count;
	}

	public void clearFailures() {
		jdbc.update("DELETE FROM collector_state WHERE `key` = ?", FAILURE_KEY);
	}

}
