package com.auctionboss.collect.collector;

import static org.assertj.core.api.Assertions.assertThat;

import java.math.BigDecimal;
import java.util.List;

import com.auctionboss.collect.collector.WatchedFields.Change;
import com.auctionboss.collect.collector.WatchedFields.Existing;
import com.auctionboss.collect.collector.WatchedFields.Kind;
import org.junit.jupiter.api.Test;

/** 감시 필드 비교 규칙 (TS {@code watchedValuesEqual}, {@code toHistoryValue}, {@code detectWatchedChanges}). */
class WatchedFieldsTest {

	@Test
	void 숫자_필드는_숫자_값으로_비교한다() {
		// 문자열 비교였다면 "1000"과 "1000.0"은 다르다.
		assertThat(WatchedFields.valuesEqual("1000", 1000.0, Kind.NUMERIC)).isTrue();
		assertThat(WatchedFields.valuesEqual(1000L, new BigDecimal("1000.00"), Kind.NUMERIC)).isTrue();
		assertThat(WatchedFields.valuesEqual(1000L, 1001L, Kind.NUMERIC)).isFalse();
	}

	@Test
	void 문자열_필드는_문자열로_비교한다() {
		assertThat(WatchedFields.valuesEqual("신건", "신건", Kind.STRING)).isTrue();
		assertThat(WatchedFields.valuesEqual("1000", "1000.0", Kind.STRING)).isFalse();
	}

	@Test
	void null은_null끼리_같고_값과는_다르다() {
		assertThat(WatchedFields.valuesEqual(null, null, Kind.NUMERIC)).isTrue();
		assertThat(WatchedFields.valuesEqual(null, 0L, Kind.NUMERIC)).isFalse();
		assertThat(WatchedFields.valuesEqual(0L, null, Kind.NUMERIC)).isFalse();
		assertThat(WatchedFields.valuesEqual(null, "", Kind.STRING)).isFalse();
	}

	@Test
	void 읽을_수_없는_숫자는_변경으로_본다() {
		assertThat(WatchedFields.valuesEqual("abc", "abc", Kind.NUMERIC)).isFalse();
	}

	@Test
	void 이력_값은_정수를_소수점_없이_쓴다() {
		assertThat(WatchedFields.toHistoryValue(1000L)).isEqualTo("1000");
		assertThat(WatchedFields.toHistoryValue(1000.0)).isEqualTo("1000");
		assertThat(WatchedFields.toHistoryValue(new BigDecimal("1000.00"))).isEqualTo("1000");
		assertThat(WatchedFields.toHistoryValue("2026-11-05")).isEqualTo("2026-11-05");
		assertThat(WatchedFields.toHistoryValue(null)).isNull();
	}

	@Test
	void 변경은_정의_순서로_다른_필드만_돌려준다() {
		var incoming = TestItems.item("1", 900L, 1L, "2026-11-05", "유찰 1회");
		var existing = new Existing(1, 1000L, 0L, "2026-11-05", "신건");
		List<Change> changes = WatchedFields.detectChanges(existing, incoming);
		assertThat(changes).extracting(Change::field).containsExactly("minBidPrice", "failedBidCount", "status");
		assertThat(changes.get(0)).isEqualTo(new Change("minBidPrice", "1000", "900"));
	}

	@Test
	void 기준점은_값이_있는_필드만_만든다() {
		var incoming = TestItems.item("1", 900L, 0L, null, "신건");
		assertThat(WatchedFields.baselines(incoming)).extracting(Change::field)
			.containsExactly("minBidPrice", "failedBidCount", "status");
		assertThat(WatchedFields.baselines(incoming)).allMatch(c -> c.oldValue() == null);
	}

}
