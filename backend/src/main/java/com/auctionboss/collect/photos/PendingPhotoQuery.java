package com.auctionboss.collect.photos;

import java.time.Instant;
import java.time.LocalDateTime;
import java.time.ZoneOffset;
import java.util.List;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

/**
 * 사진 수집 대기 물건 선택(TS {@code selectPendingPhotoItems}와 같은 조건·정렬).
 *
 * <ul>
 * <li>조건: {@code internal_case_no IS NOT NULL AND court_code IS NOT NULL}(빈 문자열은 통과한다: 워커가 건너뛴다)이고, 미시도(상태
 * NULL·{@code uncollected}) 또는 실패({@code failed})이면서 마지막 시도가 {@code now - retryAfterHours} 이전(같은 시각 포함)이거나
 * 시도 기록이 없는 물건.</li>
 * <li>정렬: 미시도 먼저, 마지막 시도 시각 오름차순(NULL 먼저), {@code id} 내림차순.</li>
 * </ul>
 */
@Component
public class PendingPhotoQuery {

	private static final String SQL = """
			SELECT id, internal_case_no, court_code
			FROM items
			WHERE internal_case_no IS NOT NULL
			  AND court_code IS NOT NULL
			  AND (
			    photo_status IS NULL OR photo_status = 'uncollected'
			    OR (photo_status = 'failed' AND (photo_attempted_at IS NULL OR photo_attempted_at <= ?))
			  )
			ORDER BY
			  CASE WHEN (photo_status IS NULL OR photo_status = 'uncollected') THEN 0 ELSE 1 END,
			  photo_attempted_at ASC,
			  id DESC
			LIMIT ?""";

	private final JdbcTemplate jdbc;

	PendingPhotoQuery(JdbcTemplate jdbc) {
		this.jdbc = jdbc;
	}

	public List<PendingPhoto> find(long limit, Instant now, long retryAfterHours) {
		Instant retryBefore = now.minusMillis(retryAfterHours * 3_600_000L);
		return jdbc.query(SQL,
				(rs, i) -> new PendingPhoto(rs.getLong("id"), rs.getString("internal_case_no"),
						rs.getString("court_code")),
				LocalDateTime.ofInstant(retryBefore, ZoneOffset.UTC), limit);
	}

}
