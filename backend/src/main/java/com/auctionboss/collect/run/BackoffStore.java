package com.auctionboss.collect.run;

import java.time.Instant;
import java.time.LocalDateTime;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.time.format.DateTimeParseException;
import java.util.List;
import java.util.Optional;

import com.auctionboss.common.time.ServerClock;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

/**
 * 공유 차단 백오프({@code collector_state.backoff_until}). 소스에 요청하는 모든 워커(수집·사진)가 이 키 하나를 함께 읽고 쓴다.
 *
 * <ul>
 * <li>값은 TS {@code toISOString()}과 같은 밀리초 3자리 {@code Z} 문자열이다. 읽을 때는 {@link Instant#parse}가 받는 형식이면 되고,
 * 읽지 못하는 값은 "없음"으로 본다.</li>
 * <li>연장({@link #extend})은 한 문장이다: 저장값이 없거나 읽을 수 없거나 새 시각보다 이를 때만 덮어쓴다(짧아지지 않음). 읽기·비교·쓰기가 한
 * 문장 안에 있어 InnoDB 행 잠금으로 동시 연장이 직렬화되고, 행이 없을 때의 동시 삽입도 중복 키 갱신으로 합쳐진다. MySQL은 {@code SET}을
 * 왼쪽부터 적용하므로 {@code updated_at}을 {@code value}보다 먼저 쓴다.</li>
 * </ul>
 */
@Component
public class BackoffStore {

	public static final String KEY = "backoff_until";

	private static final DateTimeFormatter ISO_MILLIS = DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'")
		.withZone(ZoneOffset.UTC);

	private static final String DATE_TIME = "[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T"
			+ "([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]";

	/**
	 * 저장 문자열을 시각 순서로 비교할 수 있는 밀리초 3자리 {@code Z} 문자열로 정규화하는 SQL. 형식이 맞지 않으면 NULL이다. 같은 형식의 ISO
	 * 문자열은 문자열 순서가 시각 순서라 {@code STR_TO_DATE} 없이 비교한다: strict 모드에서 {@code STR_TO_DATE}는 맞지 않는 문자열에 NULL
	 * 대신 오류를 내서 "읽을 수 없는 값은 없음" 규칙을 문장 안에서 지킬 수 없다.
	 */
	private static String normalized(String column) {
		return "CASE WHEN " + column + " REGEXP '^" + DATE_TIME + "[.][0-9]{3}Z$' THEN " + column + " WHEN " + column
				+ " REGEXP '^" + DATE_TIME + "Z$' THEN CONCAT(LEFT(" + column + ", 19), '.000Z') END";
	}

	private static final String EXTEND_SQL;

	static {
		String current = normalized("collector_state.value");
		String stale = "(" + current + " IS NULL OR " + current + " < new.value)";
		EXTEND_SQL = "INSERT INTO collector_state (`key`, value, updated_at) VALUES (?, ?, ?) AS new "
				+ "ON DUPLICATE KEY UPDATE updated_at = IF(" + stale + ", new.updated_at, collector_state.updated_at), "
				+ "value = IF(" + stale + ", new.value, collector_state.value)";
	}

	private final JdbcTemplate jdbc;

	private final ServerClock clock;

	BackoffStore(JdbcTemplate jdbc, ServerClock clock) {
		this.jdbc = jdbc;
		this.clock = clock;
	}

	/** 백오프 종료 시각. 없거나 읽을 수 없으면 비어 있다. */
	public Optional<Instant> until() {
		List<String> values = jdbc.queryForList("SELECT value FROM collector_state WHERE `key` = ?", String.class,
				KEY);
		if (values.isEmpty()) {
			return Optional.empty();
		}
		try {
			return Optional.of(Instant.parse(values.get(0)));
		}
		catch (DateTimeParseException e) {
			return Optional.empty();
		}
	}

	/** {@code now} 기준 남은 시간(ms). 없거나 지났으면 0. */
	public long remainingMs(Instant now) {
		return until().map(until -> Math.max(0, until.toEpochMilli() - now.toEpochMilli())).orElse(0L);
	}

	/** 백오프를 {@code until}까지 늘린다. 저장값이 더 늦거나 같으면 아무것도 쓰지 않는다. */
	public void extend(Instant until) {
		jdbc.update(EXTEND_SQL, KEY, ISO_MILLIS.format(until), LocalDateTime.ofInstant(clock.now(), ZoneOffset.UTC));
	}

}
