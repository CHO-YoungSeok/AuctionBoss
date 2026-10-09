package com.auctionboss.migration;

import static org.assertj.core.api.Assertions.assertThat;

import java.nio.file.Path;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Optional;

import com.auctionboss.collect.collector.CollectorRun;
import com.auctionboss.collect.photos.PhotoRun;
import com.auctionboss.collect.run.RunLock;
import com.auctionboss.support.AppLauncher;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.context.ConfigurableApplicationContext;
import org.springframework.web.context.WebApplicationContext;

/**
 * 3.2: 가져오기(D5). 교차 언어 골든을 빈 대상과 시드가 있는 대상에 적재해 본다. 실패 경로는 모두 "대상이 이전 전 상태"와 "출력에 값 없음"을 확인한다.
 */
class ImportRunnerIT extends AbstractImportTest {

	private static final String SENTINEL = "__REAL_NAME_SENTINEL__";

	@Autowired
	RunLock runLock;

	private Path temp;

	@AfterEach
	void deleteTemp() {
		if (temp != null) {
			GoldenFixture.deleteTree(temp);
			temp = null;
		}
	}

	@Test
	void 빈_대상에_골든을_적재하면_성공하고_해시가_모두_일치하고_표식이_남는다() throws Exception {
		ImportReport report = importGolden(false, false);

		assertThat(report.success()).as(report.text()).isTrue();
		assertThat(report.text()).contains("Flyway 최신 확인", "컬럼 집합 확인", "검증 items: 행 3/3", "일치");
		assertThat(report.text()).doesNotContain("불일치");
		assertThat(counts()).containsExactly(Map.entry("items", 3L), Map.entry("item_changes", 3L),
				Map.entry("analyses", 2L), Map.entry("worker_runs", 3L), Map.entry("bookmarks", 1L),
				Map.entry("feed_reads", 1L), Map.entry("collector_state", 6L), // 골든 5행 + 이전 완료 표식
				Map.entry("item_photos", 3L));
		assertThat(markerExists()).isTrue();
		MigrationManifest manifest = GoldenFixture.manifest();
		Map<String, String> digests = digests();
		manifest.tables().forEach((table, t) -> assertThat(digests.get(table)).as(table).isEqualTo(t.sha256()));
		// 원본 id가 그대로다(빈 번호 포함).
		assertThat(jdbc.queryForList("SELECT id FROM items ORDER BY id", Long.class)).containsExactly(3L, 7L, 1200L);
	}

	@Test
	void 일회_실행_모드로_돌리면_웹_서버_없이_종료_코드_0이고_표식이_남는다() throws Exception {
		AppLauncher.Launched launched = AppLauncher.launch("--auctionboss.run-once=import",
				"--auctionboss.import.dir=" + GoldenFixture.DIR, "--auctionboss.photos.dir=" + photosDir());
		try (ConfigurableApplicationContext context = launched.context()) {
			assertThat(launched.exitCode()).isZero();
			assertThat(context).isNotInstanceOf(WebApplicationContext.class);
		}
		assertThat(markerExists()).isTrue();
		assertThat(counts().get("items")).isEqualTo(3L);
	}

	@Test
	void 일회_실행_모드는_실패하면_종료_코드_1이다() {
		seedTarget();
		AppLauncher.Launched launched = AppLauncher.launch("--auctionboss.run-once=import",
				"--auctionboss.import.dir=" + GoldenFixture.DIR, "--auctionboss.photos.dir=" + photosDir());
		try (ConfigurableApplicationContext context = launched.context()) {
			assertThat(launched.exitCode()).isEqualTo(1);
		}
		assertThat(counts().get("items")).isEqualTo(2L);
	}

	@Test
	void 시드가_있는_대상에_교체_없이_실행하면_테이블과_건수를_알리며_거부하고_행_수가_그대로다() throws Exception {
		seedTarget();
		Map<String, Long> before = counts();
		Map<String, String> digestsBefore = digests();

		ImportReport report = importGolden(false, false);

		assertThat(report.success()).isFalse();
		assertThat(report.text()).contains("거부", "items=2", "item_changes=1", "auctionboss.import.replace=true");
		assertThat(counts()).isEqualTo(before);
		assertThat(digests()).isEqualTo(digestsBefore);
		assertThat(markerExists()).isFalse();
	}

	@Test
	void 교체로_두_번_실행해도_같은_해시다_멱등() throws Exception {
		seedTarget();

		ImportReport first = importGolden(true, false);
		assertThat(first.success()).as(first.text()).isTrue();
		assertThat(first.text()).contains("교체");
		Map<String, String> afterFirst = digests();
		Map<String, Long> countsFirst = counts();

		ImportReport second = importGolden(true, false);
		assertThat(second.success()).as(second.text()).isTrue();

		assertThat(digests()).isEqualTo(afterFirst);
		assertThat(counts()).isEqualTo(countsFirst);
		GoldenFixture.manifest().tables().forEach((table, t) -> assertThat(afterFirst.get(table)).isEqualTo(t.sha256()));
		// 시드 행은 사라졌다.
		assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM items WHERE court = '시드법원'", Integer.class)).isZero();
		assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM collector_state WHERE `key` = 'migration.completed'", Integer.class))
			.isEqualTo(1);
	}

	@Test
	void SQL_한_행이_제약을_어기면_실패하고_8개_테이블이_이전_전_상태이며_테이블과_컬럼을_보고한다() throws Exception {
		seedTarget();
		Map<String, Long> before = counts();
		Map<String, String> digestsBefore = digests();
		temp = GoldenFixture.copy();
		Path sql = temp.resolve("sql/08_item_photos.sql");
		GoldenFixture.write(sql, GoldenFixture.read(sql).replace("'7/2.png'", "NULL"));

		ImportReport report = service.run(new ImportOptions(temp, true, false));

		assertThat(report.success()).isFalse();
		assertThat(report.text()).contains("SQL 적재에 실패했습니다", "item_photos", "컬럼 file_path");
		// 앞선 테이블(items ~ collector_state)은 이미 지웠다가 다시 적재한 뒤였다 - 모두 이전 전 상태로 돌아와야 한다.
		assertThat(counts()).isEqualTo(before);
		assertThat(digests()).isEqualTo(digestsBefore);
		assertThat(jdbc.queryForObject("SELECT address FROM items WHERE id = 900", String.class)).isEqualTo("SEED-ADDRESS");
		assertThat(markerExists()).isFalse();
		assertThat(photosDirEmpty()).isTrue();
	}

	@Test
	void 적재_뒤_값이_바뀌면_해시_불일치로_실패하고_롤백하며_출력에_id와_컬럼_이름만_있다() throws Exception {
		hook.afterLoad = connection -> {
			try (var st = connection.prepareStatement("UPDATE items SET note = ? WHERE id = 3")) {
				st.setString(1, SENTINEL);
				st.executeUpdate();
			}
		};

		ImportReport report = importGolden(false, false);

		assertThat(report.success()).isFalse();
		assertThat(report.text()).contains("해시 대조가 일치하지 않습니다", "[items]", "처음 다른 행: 키 3, 컬럼 note");
		assertThat(report.text()).doesNotContain(SENTINEL);
		assertThat(counts().values()).containsOnly(0L);
		assertThat(markerExists()).isFalse();
		assertThat(photosDirEmpty()).isTrue();
	}

	@Test
	void 컬럼_집합이_매니페스트와_다르면_아무것도_쓰지_않고_중단한다() {
		temp = GoldenFixture.copy();
		Path manifest = temp.resolve("manifest.json");
		GoldenFixture.write(manifest, GoldenFixture.read(manifest).replaceFirst("\\n\\s+\"note\",", ""));

		ImportReport report = service.run(new ImportOptions(temp, false, false));

		assertThat(report.success()).isFalse();
		assertThat(report.text()).contains("컬럼 집합이 다릅니다", "items", "[note]");
		assertThat(counts().values()).containsOnly(0L);
	}

	@Test
	void 드라이런은_끝까지_돌리고_롤백해_8개_테이블이_비어_있고_표식도_없다() {
		ImportReport report = importGolden(false, true);

		assertThat(report.success()).as(report.text()).isTrue();
		assertThat(report.text()).contains("드라이런", "검증 item_photos: 행 3/3", "일치");
		assertThat(counts().values()).containsOnly(0L);
		assertThat(markerExists()).isFalse();
		assertThat(photosDirEmpty()).isTrue();
	}

	@Test
	void 시드가_있는_대상에_교체_드라이런을_해도_시드가_그대로_남는다() throws Exception {
		seedTarget();
		Map<String, Long> before = counts();
		Map<String, String> digestsBefore = digests();

		ImportReport report = importGolden(true, true);

		assertThat(report.success()).as(report.text()).isTrue();
		assertThat(counts()).isEqualTo(before);
		assertThat(digests()).isEqualTo(digestsBefore);
		assertThat(markerExists()).isFalse();
	}

	@Test
	void 커밋_뒤_새_물건_id는_원본_시퀀스보다_크다() {
		ImportReport report = importGolden(false, false);
		assertThat(report.success()).as(report.text()).isTrue();
		assertThat(report.text()).contains("AUTO_INCREMENT items = 5001");

		Timestamp t = Timestamp.from(Instant.parse("2026-10-09T00:00:00Z"));
		jdbc.update("INSERT INTO items (court, case_no, item_no, first_seen_at, last_seen_at) VALUES ('새법원', '새1', '1', ?, ?)", t, t);
		long newItem = jdbc.queryForObject("SELECT id FROM items WHERE court = '새법원'", Long.class);
		// 원본: 최대 id 1200이지만 삭제된 5000이 있어 sqlite_sequence = 5000. 새 행은 그 위에서 시작해야 한다.
		assertThat(newItem).isGreaterThanOrEqualTo(5001L);
		jdbc.update("INSERT INTO item_changes (item_id, field, new_value, changed_at, kind) VALUES (?, 'status', 'x', ?, 'change')", newItem, t);
		assertThat(jdbc.queryForObject("SELECT MAX(id) FROM item_changes", Long.class)).isGreaterThanOrEqualTo(51L);
	}

	@Test
	void 수집_잠금을_다른_연결이_잡고_있으면_중단한다() {
		Optional<RunLock.Held> held = runLock.tryAcquire(CollectorRun.LOCK_NAME);
		assertThat(held).isPresent();
		try (RunLock.Held lock = held.get()) {
			ImportReport report = importGolden(false, false);

			assertThat(report.success()).isFalse();
			assertThat(report.text()).contains("잠금", CollectorRun.LOCK_NAME);
		}
		assertThat(counts().values()).containsOnly(0L);
	}

	@Test
	void 사진_잠금을_다른_연결이_잡고_있어도_중단한다() {
		try (RunLock.Held lock = runLock.tryAcquire(PhotoRun.LOCK_NAME).orElseThrow()) {
			ImportReport report = importGolden(false, false);

			assertThat(report.success()).isFalse();
			assertThat(report.text()).contains("잠금", PhotoRun.LOCK_NAME);
		}
		assertThat(counts().values()).containsOnly(0L);
	}

	@Test
	void 가져오기_뒤에는_잠금이_풀려_수집과_사진_잠금을_다시_얻을_수_있다() {
		assertThat(importGolden(false, false).success()).isTrue();
		for (String name : List.of(CollectorRun.LOCK_NAME, PhotoRun.LOCK_NAME)) {
			Optional<RunLock.Held> held = runLock.tryAcquire(name);
			assertThat(held).as(name).isPresent();
			held.get().close();
		}
	}

}
