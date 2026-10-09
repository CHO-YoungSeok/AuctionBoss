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

}
