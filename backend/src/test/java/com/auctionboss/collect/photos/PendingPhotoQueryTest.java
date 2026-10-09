package com.auctionboss.collect.photos;

import static org.assertj.core.api.Assertions.assertThat;

import java.time.Instant;
import java.time.LocalDateTime;
import java.time.ZoneOffset;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;

import com.auctionboss.support.AbstractPhotoTest;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;

/** 6.1: 사진 대기 물건 선택(design D10). 실제 MySQL에서 조건과 정렬을 확인한다. */
class PendingPhotoQueryTest extends AbstractPhotoTest {

	private static final Instant NOW = Instant.parse("2026-10-08T12:00:00Z");

	private final AtomicInteger counter = new AtomicInteger();

	@Autowired
	PendingPhotoQuery query;

	private long item(String internalCaseNo, String courtCode, String status, Instant attemptedAt) {
		String caseNo = "2026타경" + counter.incrementAndGet();
		LocalDateTime at = LocalDateTime.ofInstant(NOW, ZoneOffset.UTC);
		jdbc.update("""
				INSERT INTO items (court, case_no, item_no, first_seen_at, last_seen_at, internal_case_no, court_code,
				                   photo_status, photo_attempted_at)
				VALUES ('서울중앙지방법원', ?, '1', ?, ?, ?, ?, ?, ?)""", caseNo, at, at, internalCaseNo, courtCode, status,
				attemptedAt == null ? null : LocalDateTime.ofInstant(attemptedAt, ZoneOffset.UTC));
		return jdbc.queryForObject("SELECT id FROM items WHERE case_no = ?", Long.class, caseNo);
	}

	private long item(String status, Instant attemptedAt) {
		return item("20260130000001", "B000210", status, attemptedAt);
	}

	private List<Long> ids(long limit) {
		return query.find(limit, NOW, 24).stream().map(PendingPhoto::id).toList();
	}

	@Test
	void 식별자가_NULL인_물건은_제외하고_빈_문자열은_포함한다() {
		item(null, "B000210", null, null);
		item("20260130000001", null, null, null);
		long empty = item("", "B000210", null, null);
		long emptyCourt = item("20260130000001", "", null, null);
		long ok = item(null, null);

		assertThat(ids(10)).containsExactlyInAnyOrder(empty, emptyCourt, ok);
	}

	@Test
	void 수집됨과_사진없음은_제외한다() {
		item("collected", NOW.minusSeconds(100 * 3600));
		item("empty", NOW.minusSeconds(100 * 3600));
		long uncollected = item("uncollected", null);
		long none = item(null, null);

		assertThat(ids(10)).containsExactlyInAnyOrder(uncollected, none);
	}

	@Test
	void 실패_물건은_재시도_간격_전에는_제외하고_후에는_포함한다() {
		long justFailed = item("failed", NOW.minusSeconds(3600)); // 1시간 전
		long almost = item("failed", NOW.minusSeconds(24 * 3600 - 1)); // 24시간에 1초 모자람
		long exactly = item("failed", NOW.minusSeconds(24 * 3600)); // 같은 시각 포함
		long old = item("failed", NOW.minusSeconds(25 * 3600));
		long never = item("failed", null); // 시도 시각이 없으면 포함

		assertThat(ids(10)).containsExactlyInAnyOrder(exactly, old, never).doesNotContain(justFailed, almost);
	}

	@Test
	void 미시도가_실패보다_먼저이고_각각_시도_시각_오름차순_id_내림차순이다() {
		long failedOld = item("failed", NOW.minusSeconds(48 * 3600));
		long failedOlder = item("failed", NOW.minusSeconds(72 * 3600));
		long failedNullTime = item("failed", null);
		long freshLow = item(null, null);
		long freshHigh = item("uncollected", null);

		// 미시도: id 내림차순. 실패: 시도 시각 오름차순(NULL 먼저)
		assertThat(ids(10)).containsExactly(freshHigh, freshLow, failedNullTime, failedOlder, failedOld);
	}

	@Test
	void 같은_시도_시각이면_id_내림차순이다() {
		Instant same = NOW.minusSeconds(30 * 3600);
		long low = item("failed", same);
		long high = item("failed", same);

		assertThat(ids(10)).containsExactly(high, low);
	}

	@Test
	void 한도만큼만_돌려준다() {
		for (int i = 0; i < 5; i++) {
			item(null, null);
		}

		assertThat(ids(3)).hasSize(3);
	}

	@Test
	void 재시도_간격은_시간_단위로_계산한다() {
		long failed = item("failed", NOW.minusSeconds(2 * 3600));

		assertThat(query.find(10, NOW, 1)).extracting(PendingPhoto::id).containsExactly(failed);
		assertThat(query.find(10, NOW, 3)).isEmpty();
	}

	@Test
	void 물건_지정은_대기_조건을_통과한_그_물건만_돌려준다() {
		long target = item(null, null);
		item(null, null);
		long collected = item("collected", NOW.minusSeconds(100 * 3600));
		long noIdentifier = item(null, "B000210", null, null);

		assertThat(query.find(10, NOW, 24, target)).extracting(PendingPhoto::id).containsExactly(target);
		assertThat(query.find(10, NOW, 24, collected)).as("대기 조건 밖이면 지정해도 제외").isEmpty();
		assertThat(query.find(10, NOW, 24, noIdentifier)).isEmpty();
		assertThat(query.find(10, NOW, 24, null)).as("지정 없음은 좁히지 않는다").hasSize(2);
	}

}
