package com.auctionboss.migration;

import java.time.Instant;
import java.time.LocalDateTime;
import java.time.ZoneOffset;
import java.util.LinkedHashMap;
import java.util.Map;

import org.springframework.jdbc.core.JdbcTemplate;

/**
 * 롤백 전 기록(design D11): 기준 시각 이후({@code >=}) 생긴 행의 건수를 테이블별로 센다. 값은 읽지 않고 건수만 낸다. 기준 컬럼: 물건
 * {@code first_seen_at}, 변경 이력 {@code changed_at}, 분석 {@code analyzed_at}, 회차 {@code started_at}, 관심
 * {@code created_at}, 사진 기록 {@code collected_at}. 출력은 한 줄 JSON이다.
 */
public final class DeltaReporter {

	private static final Map<String, String> COLUMNS = new LinkedHashMap<>();

	static {
		COLUMNS.put("items", "first_seen_at");
		COLUMNS.put("item_changes", "changed_at");
		COLUMNS.put("analyses", "analyzed_at");
		COLUMNS.put("worker_runs", "started_at");
		COLUMNS.put("bookmarks", "created_at");
		COLUMNS.put("item_photos", "collected_at");
	}

	private final JdbcTemplate jdbc;

	DeltaReporter(JdbcTemplate jdbc) {
		this.jdbc = jdbc;
	}

	public String report(Instant since) {
		LocalDateTime at = LocalDateTime.ofInstant(since, ZoneOffset.UTC);
		StringBuilder out = new StringBuilder("{\"since\":\"").append(since).append('"');
		COLUMNS.forEach((table, column) -> {
			Long n = jdbc.queryForObject("SELECT COUNT(*) FROM `" + table + "` WHERE `" + column + "` >= ?", Long.class, at);
			out.append(",\"").append(table).append("\":").append(n == null ? 0 : n);
		});
		return out.append('}').toString();
	}

}
