package com.auctionboss.support;

import java.sql.Timestamp;
import java.time.Instant;

import com.auctionboss.item.Item;
import org.springframework.jdbc.core.JdbcTemplate;

public final class TestData {

	public static final Instant T0 = Instant.parse("2026-09-08T11:48:38.617Z");

	private TestData() {
	}

	public static Item.Builder item(String caseNo, String itemNo) {
		return Item.builder("서울중앙지방법원", caseNo, itemNo, T0, T0);
	}

	/** 회차 한 건을 직접 넣는다(API로 만들 수 없는 건너뜀 회차 등). 종료 시각이 null이면 진행 중이다. */
	public static void insertRun(JdbcTemplate jdbc, String worker, Instant startedAt, Instant finishedAt,
			String outcome) {
		jdbc.update("INSERT INTO worker_runs (worker, started_at, finished_at, outcome, created_at) VALUES (?, ?, ?, ?, ?)",
				worker, Timestamp.from(startedAt), finishedAt == null ? null : Timestamp.from(finishedAt), outcome,
				Timestamp.from(startedAt));
	}

	/** 법원·시도·시군구만 정한 물건 한 건을 직접 넣는다(선택지 테스트용). 사건번호는 호출마다 달라야 한다. */
	public static long insertItem(JdbcTemplate jdbc, String court, String caseNo, String sido, String sigungu) {
		jdbc.update("INSERT INTO items (court, case_no, item_no, sido, sigungu, first_seen_at, last_seen_at) "
				+ "VALUES (?, ?, '1', ?, ?, ?, ?)", court, caseNo, sido, sigungu, Timestamp.from(T0), Timestamp.from(T0));
		return jdbc.queryForObject("SELECT MAX(id) FROM items", Long.class);
	}

}
