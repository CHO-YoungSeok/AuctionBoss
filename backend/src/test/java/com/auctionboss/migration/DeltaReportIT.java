package com.auctionboss.migration;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.time.LocalDateTime;

import com.auctionboss.support.AbstractMySqlTest;
import com.auctionboss.support.AppLauncher;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.springframework.boot.test.system.CapturedOutput;
import org.springframework.boot.test.system.OutputCaptureExtension;

/** 3.5: {@code auctionboss.run-once=delta-report}. 기준 시각 이후({@code >=}) 행만 테이블별 건수로 세고, 출력에는 값이 없다. */
@ExtendWith(OutputCaptureExtension.class)
class DeltaReportIT extends AbstractMySqlTest {

	private static final String SENTINEL = "__REAL_NAME_SENTINEL__";

	private static final LocalDateTime BEFORE = LocalDateTime.of(2026, 9, 30, 23, 59, 59, 999_000_000);

	private static final LocalDateTime SINCE = LocalDateTime.of(2026, 10, 1, 0, 0, 0);

	private static final LocalDateTime AFTER = LocalDateTime.of(2026, 10, 2, 0, 0, 0);

	private void seed() {
		// items: 기준 직전 1, 기준 시각 정확히 1, 이후 1 -> 2건
		jdbc.update("INSERT INTO items (id, court, case_no, item_no, address, note, first_seen_at, last_seen_at) VALUES (1, ?, 'c1', '1', ?, ?, ?, ?)", SENTINEL, SENTINEL, SENTINEL, BEFORE, BEFORE);
		jdbc.update("INSERT INTO items (id, court, case_no, item_no, first_seen_at, last_seen_at) VALUES (2, ?, 'c2', '1', ?, ?)", SENTINEL, SINCE, SINCE);
		jdbc.update("INSERT INTO items (id, court, case_no, item_no, first_seen_at, last_seen_at) VALUES (3, ?, 'c3', '1', ?, ?)", SENTINEL, AFTER, AFTER);
		// item_changes: 이후 2, 이전 1 -> 2건
		jdbc.update("INSERT INTO item_changes (item_id, field, old_value, new_value, changed_at, kind) VALUES (1, 'note', ?, ?, ?, 'change')", SENTINEL, SENTINEL, BEFORE);
		jdbc.update("INSERT INTO item_changes (item_id, field, new_value, changed_at, kind) VALUES (1, 'status', ?, ?, 'change')", SENTINEL, AFTER);
		jdbc.update("INSERT INTO item_changes (item_id, field, new_value, changed_at, kind) VALUES (2, 'status', ?, ?, 'baseline')", SENTINEL, SINCE);
		// analyses: 이전만 -> 0건
		jdbc.update("INSERT INTO analyses (item_id, body, prompt_version, analyzed_at) VALUES (1, ?, 'v1', ?)", SENTINEL, BEFORE);
		// worker_runs: 이후 1건
		jdbc.update("INSERT INTO worker_runs (worker, started_at, outcome, error_message, created_at) VALUES ('collector', ?, 'failed', ?, ?)", AFTER, SENTINEL, AFTER);
		jdbc.update("INSERT INTO worker_runs (worker, started_at, outcome, created_at) VALUES ('collector', ?, 'success', ?)", BEFORE, BEFORE);
		// bookmarks: 이후 1건
		jdbc.update("INSERT INTO bookmarks (item_id, created_at) VALUES (3, ?)", AFTER);
		// item_photos: 이후 1건
		jdbc.update("INSERT INTO item_photos (item_id, seq, file_path, file_size, mime_type, collected_at) VALUES (3, 1, ?, 3, 'image/jpeg', ?)", SENTINEL + "/1.jpg", AFTER);
	}

	@Test
	void 기준_시각_이후_행만_테이블별_건수로_세고_출력에_값이_없다(CapturedOutput output) {
		seed();

		AppLauncher.Launched launched = AppLauncher.launch("--spring.profiles.active=test",
				"--auctionboss.run-once=delta-report", "--auctionboss.delta.since=2026-10-01T00:00:00.000Z");
		launched.context().close();

		assertThat(launched.exitCode()).isZero();
		assertThat(output.getOut()).contains("{\"since\":\"2026-10-01T00:00:00Z\",\"items\":2,\"item_changes\":2,"
				+ "\"analyses\":0,\"worker_runs\":1,\"bookmarks\":1,\"item_photos\":1}");
		assertThat(output.getAll()).doesNotContain(SENTINEL);
	}

	@Test
	void 기준_시각이_없거나_형식이_틀리면_기동이_실패한다() {
		assertThatThrownBy(() -> AppLauncher.launch("--spring.profiles.active=test", "--auctionboss.run-once=delta-report"))
			.rootCause()
			.hasMessageContaining("auctionboss.delta.since");
		assertThatThrownBy(() -> AppLauncher.launch("--spring.profiles.active=test", "--auctionboss.run-once=delta-report",
				"--auctionboss.delta.since=yesterday"))
			.rootCause()
			.hasMessageContaining("ISO-8601");
	}

}
