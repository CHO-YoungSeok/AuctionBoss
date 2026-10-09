package com.auctionboss.migration;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.function.Consumer;
import java.util.stream.Stream;
import javax.sql.DataSource;

import com.auctionboss.support.AbstractMySqlTest;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Import;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MockMvc;

/**
 * 가져오기 통합 테스트의 베이스. 한 스프링 컨텍스트를 모두가 공유한다(컨텍스트마다 연결 풀을 쥐므로 늘리지 않는다): 임시 사진 디렉터리, MockMvc, 시험용
 * {@link ImportHook}. 공용 MySQL 컨테이너를 쓰므로 {@code AUTO_INCREMENT}는 테스트 뒤에 되돌린다(가져오기가 올려 둔 값이 다른 테스트에 새지 않게).
 */
@AutoConfigureMockMvc
@Import(AbstractImportTest.HookConfig.class)
abstract class AbstractImportTest extends AbstractMySqlTest {

	private static final Path PHOTOS_DIR = createDirectory();

	private static Path createDirectory() {
		try {
			return Files.createTempDirectory("auctionboss-import-photos-");
		}
		catch (IOException e) {
			throw new UncheckedIOException(e);
		}
	}

	/** 테스트가 가져오기 단계에 끼어드는 훅. 테스트마다 비운다. */
	static final class TestHook implements ImportHook {

		volatile SqlConsumer afterLoad = c -> {
		};

		volatile Consumer<Path> afterPhotos = p -> {
		};

		@Override
		public void afterLoad(Connection connection) throws SQLException {
			afterLoad.accept(connection);
		}

		@Override
		public void afterPhotosCopied(Path photosRoot) {
			afterPhotos.accept(photosRoot);
		}

	}

	@FunctionalInterface
	interface SqlConsumer {

		void accept(Connection connection) throws SQLException;

	}

	@TestConfiguration(proxyBeanMethods = false)
	static class HookConfig {

		@Bean
		TestHook testHook() {
			return new TestHook();
		}

	}

	@DynamicPropertySource
	static void photosDirectory(DynamicPropertyRegistry registry) {
		registry.add("auctionboss.photos.dir", PHOTOS_DIR::toString);
	}

	@Autowired
	protected ImportService service;

	@Autowired
	protected DataSource dataSource;

	@Autowired
	protected MockMvc mvc;

	@Autowired
	protected TestHook hook;

	protected static Path photosDir() {
		return PHOTOS_DIR;
	}

	@BeforeEach
	void resetHookAndPhotos() {
		hook.afterLoad = c -> {
		};
		hook.afterPhotos = p -> {
		};
		emptyPhotosDir();
	}

	@AfterEach
	void restoreAutoIncrement() {
		emptyPhotosDir();
		// 테이블은 AbstractMySqlTest가 비웠다. 비어 있으면 AUTO_INCREMENT를 1로 되돌릴 수 있다.
		for (String table : new String[] { "items", "item_changes", "analyses", "worker_runs", "item_photos" }) {
			jdbc.execute("ALTER TABLE `" + table + "` AUTO_INCREMENT = 1");
		}
	}

	protected static void emptyPhotosDir() {
		try (Stream<Path> walk = Files.walk(PHOTOS_DIR)) {
			walk.sorted(Comparator.reverseOrder()).filter(p -> !p.equals(PHOTOS_DIR)).forEach(p -> p.toFile().delete());
		}
		catch (IOException e) {
			throw new UncheckedIOException(e);
		}
	}

	protected static boolean photosDirEmpty() {
		try (Stream<Path> walk = Files.walk(PHOTOS_DIR)) {
			return walk.noneMatch(p -> !p.equals(PHOTOS_DIR));
		}
		catch (IOException e) {
			throw new UncheckedIOException(e);
		}
	}

	protected ImportReport importGolden(boolean replace, boolean dryRun) {
		return service.run(new ImportOptions(GoldenFixture.DIR, replace, dryRun));
	}

	/** 8개 테이블의 행 수. 이전 완료 표식 행도 센다. */
	protected Map<String, Long> counts() {
		Map<String, Long> counts = new LinkedHashMap<>();
		for (String table : ImportService.TABLES) {
			counts.put(table, jdbc.queryForObject("SELECT COUNT(*) FROM `" + table + "`", Long.class));
		}
		return counts;
	}

	/** 8개 테이블의 해시(표식 제외). 같은 컬럼 순서로 계산하므로 두 상태를 비교할 수 있다. */
	protected Map<String, String> digests() throws SQLException {
		MigrationManifest manifest = GoldenFixture.manifest();
		Map<String, String> digests = new LinkedHashMap<>();
		try (Connection connection = dataSource.getConnection()) {
			for (String table : ImportService.TABLES) {
				digests.put(table, TableDigest.compute(connection, table, manifest.tables().get(table).columns()).sha256());
			}
		}
		return digests;
	}

	protected boolean markerExists() {
		return MigrationMarker.exists(jdbc);
	}

	/** 8개 테이블에 행이 하나씩 이상 있는 "시드가 있는 대상". */
	protected void seedTarget() {
		Timestamp t = Timestamp.from(Instant.parse("2026-09-01T00:00:00Z"));
		jdbc.update("INSERT INTO items (id, court, case_no, item_no, address, first_seen_at, last_seen_at) VALUES (900, '시드법원', '시드1', '1', 'SEED-ADDRESS', ?, ?)", t, t);
		jdbc.update("INSERT INTO items (id, court, case_no, item_no, first_seen_at, last_seen_at) VALUES (901, '시드법원', '시드2', '1', ?, ?)", t, t);
		jdbc.update("INSERT INTO item_changes (id, item_id, field, new_value, changed_at, kind) VALUES (800, 900, 'status', 'x', ?, 'change')", t);
		jdbc.update("INSERT INTO analyses (id, item_id, body, prompt_version, analyzed_at) VALUES (700, 900, 'seed body', 'v1', ?)", t);
		jdbc.update("INSERT INTO worker_runs (id, worker, started_at, outcome, created_at) VALUES (600, 'collector', ?, 'success', ?)", t, t);
		jdbc.update("INSERT INTO bookmarks (item_id, created_at) VALUES (900, ?)", t);
		jdbc.update("INSERT INTO feed_reads (id, last_read_at) VALUES (1, ?)", t);
		jdbc.update("INSERT INTO collector_state (`key`, value, updated_at) VALUES ('seed.key', 'seed', ?)", t);
		jdbc.update("INSERT INTO item_photos (id, item_id, seq, file_path, file_size, mime_type, collected_at) VALUES (500, 900, 1, '900/1.jpg', 3, 'image/jpeg', ?)", t);
	}

}
