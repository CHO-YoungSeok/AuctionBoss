package com.auctionboss.migration;

import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.SQLException;
import java.time.LocalDateTime;

import org.springframework.jdbc.core.JdbcTemplate;

/**
 * 이전 완료 표식(design D7): {@code collector_state}의 키 {@value #KEY}. 값은 매니페스트 해시 요약 JSON, {@code updated_at}은 완료 시각이다.
 * 새 테이블을 만들지 않으므로 8개 테이블 1:1 요구사항과 Flyway가 그대로다. 화면의 로테이션 조회와 백오프 판정은 자기 키만 읽는다.
 */
final class MigrationMarker {

	static final String KEY = "migration.completed";

	private MigrationMarker() {
	}

	/** 가져오기 트랜잭션 안에서 표식을 쓴다(이미 있으면 갱신). */
	static void write(Connection connection, String value, LocalDateTime at) throws SQLException {
		try (PreparedStatement st = connection.prepareStatement(
				"INSERT INTO collector_state (`key`, value, updated_at) VALUES (?, ?, ?) AS new "
						+ "ON DUPLICATE KEY UPDATE value = new.value, updated_at = new.updated_at")) {
			st.setString(1, KEY);
			st.setString(2, value);
			st.setObject(3, at);
			st.executeUpdate();
		}
	}

	static boolean exists(JdbcTemplate jdbc) {
		Integer n = jdbc.queryForObject("SELECT COUNT(*) FROM collector_state WHERE `key` = ?", Integer.class, KEY);
		return n != null && n > 0;
	}

}
