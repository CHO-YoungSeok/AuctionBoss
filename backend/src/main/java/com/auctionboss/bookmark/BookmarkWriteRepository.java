package com.auctionboss.bookmark;

import java.time.Instant;
import java.time.LocalDateTime;
import java.time.ZoneOffset;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * 관심·읽음 쓰기. MySQL 방언이 필요해 네이티브 SQL이다. 호출은 쓰기 트랜잭션 안에서 한다.
 */
@Repository
class BookmarkWriteRepository {

	private final JdbcTemplate jdbc;

	BookmarkWriteRepository(JdbcTemplate jdbc) {
		this.jdbc = jdbc;
	}

	/**
	 * 이미 담겼으면 아무것도 바꾸지 않는다(처음 담은 시각 보존). {@code INSERT IGNORE}는 외래 키·CHECK 위반까지 삼키므로 쓰지
	 * 않고, 중복 키일 때만 자기 자신을 대입하는 갱신 절을 쓴다.
	 */
	void addIfAbsent(long itemId, Instant at) {
		jdbc.update("INSERT INTO bookmarks (item_id, created_at) VALUES (?, ?) ON DUPLICATE KEY UPDATE item_id = item_id",
				itemId, utc(at));
	}

	void remove(long itemId) {
		jdbc.update("DELETE FROM bookmarks WHERE item_id = ?", itemId);
	}

	/** 단일 행(id=1) upsert. 행 별칭 문법(MySQL 8.0.19+)을 쓴다. */
	void upsertFeedRead(Instant at) {
		jdbc.update("INSERT INTO feed_reads (id, last_read_at) VALUES (1, ?) AS new "
				+ "ON DUPLICATE KEY UPDATE last_read_at = new.last_read_at", utc(at));
	}

	private static LocalDateTime utc(Instant at) {
		return LocalDateTime.ofInstant(at, ZoneOffset.UTC);
	}

}
