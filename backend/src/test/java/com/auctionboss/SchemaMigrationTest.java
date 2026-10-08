package com.auctionboss;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.sql.SQLException;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

import com.auctionboss.support.AbstractMySqlTest;
import com.auctionboss.support.MySqlTestContainer;
import org.flywaydb.core.Flyway;
import org.flywaydb.core.api.exception.FlywayValidateException;
import org.junit.jupiter.api.Test;
import org.springframework.boot.WebApplicationType;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;

/** 스펙 "스키마 버전 관리": 빈 DB 적용, 재적용, 변조 거부. */
class SchemaMigrationTest extends AbstractMySqlTest {

	private static final Set<String> TABLES = Set.of("items", "analyses", "item_changes", "worker_runs", "bookmarks",
			"feed_reads", "collector_state", "item_photos");

	@Test
	void appliesBaselineToEmptyDatabase() {
		List<String> tables = jdbc.queryForList(
				"SELECT table_name FROM information_schema.tables WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE'",
				String.class);
		assertThat(tables).containsAll(TABLES);
		assertThat(tables).hasSize(TABLES.size() + 1).contains("flyway_schema_history");

		Map<String, Object> v1 = jdbc.queryForMap(
				"SELECT version, success FROM flyway_schema_history WHERE version = '1'");
		assertThat(v1.get("success")).isIn(true, 1);
	}

	@Test
	void v2AddsNullablePhotoAttemptedAtColumn() {
		Map<String, Object> v2 = jdbc.queryForMap(
				"SELECT version, success FROM flyway_schema_history WHERE version = '2'");
		assertThat(v2.get("success")).isIn(true, 1);

		Map<String, Object> column = jdbc.queryForMap(
				"SELECT data_type AS data_type, is_nullable AS is_nullable, datetime_precision AS prec "
						+ "FROM information_schema.columns WHERE table_schema = DATABASE() "
						+ "AND table_name = 'items' AND column_name = 'photo_attempted_at'");
		assertThat(column.get("data_type").toString()).isEqualToIgnoringCase("datetime");
		assertThat(column.get("is_nullable").toString()).isEqualToIgnoringCase("YES");
		assertThat(((Number) column.get("prec")).intValue()).isEqualTo(3);
	}

	@Test
	void v3WidensAnalysisColumnsForWriteApi() {
		Map<String, Object> v3 = jdbc.queryForMap(
				"SELECT version, success FROM flyway_schema_history WHERE version = '3'");
		assertThat(v3.get("success")).isIn(true, 1);

		Map<String, Map<String, Object>> columns = new java.util.HashMap<>();
		for (Map<String, Object> row : jdbc.queryForList(
				"SELECT column_name AS name, data_type AS data_type, character_maximum_length AS max_len, "
						+ "is_nullable AS is_nullable FROM information_schema.columns "
						+ "WHERE table_schema = DATABASE() AND table_name = 'analyses'")) {
			columns.put(row.get("name").toString(), row);
		}
		assertThat(columns.get("body").get("data_type").toString()).isEqualToIgnoringCase("mediumtext");
		assertThat(columns.get("body").get("is_nullable").toString()).isEqualToIgnoringCase("NO");
		assertThat(columns.get("model").get("data_type").toString()).isEqualToIgnoringCase("varchar");
		assertThat(((Number) columns.get("model").get("max_len")).intValue()).isEqualTo(255);
		assertThat(columns.get("model").get("is_nullable").toString()).isEqualToIgnoringCase("YES");
		assertThat(((Number) columns.get("prompt_version").get("max_len")).intValue()).isEqualTo(255);
		assertThat(columns.get("prompt_version").get("is_nullable").toString()).isEqualToIgnoringCase("NO");
	}

	/** 기존 DB 파일 경로: V2 상태에서 데이터를 넣고 V3를 적용해도 행이 살아 있고 제약이 유지된다. */
	@Test
	void v3AppliedOverExistingV2DataKeepsRowsAndForeignKey() {
		String db = freshDatabase();
		Flyway.configure().dataSource(dataSourceFor(db)).locations("classpath:db/migration").target("2").load().migrate();
		JdbcTemplate old = new JdbcTemplate(dataSourceFor(db));
		old.update("INSERT INTO items (court, case_no, item_no, first_seen_at, last_seen_at) "
				+ "VALUES ('c', 'n', '1', NOW(3), NOW(3))");
		long itemId = old.queryForObject("SELECT id FROM items", Long.class);
		old.update("INSERT INTO analyses (item_id, body, model, prompt_version, analyzed_at) "
				+ "VALUES (?, 'old body', 'm', 'v1', '2026-01-02 03:04:05.678')", itemId);

		assertThat(flywayFor(db).migrate().migrationsExecuted).isEqualTo(1);

		assertThat(old.queryForObject("SELECT body FROM analyses", String.class)).isEqualTo("old body");
		assertThat(old.queryForObject("SELECT model FROM analyses", String.class)).isEqualTo("m");
		assertThat(old.queryForObject("SELECT prompt_version FROM analyses", String.class)).isEqualTo("v1");
		assertThat(old.queryForObject("SELECT DATE_FORMAT(analyzed_at, '%Y-%m-%d %H:%i:%s.%f') FROM analyses",
				String.class)).startsWith("2026-01-02 03:04:05.678");
		// 넓어진 컬럼에 긴 값이 들어가고, 외래 키(ON DELETE CASCADE)는 그대로다.
		old.update("INSERT INTO analyses (item_id, body, model, prompt_version, analyzed_at) VALUES (?, ?, ?, ?, NOW(3))",
				itemId, "x".repeat(200_000), "m".repeat(200), "p".repeat(200));
		old.update("DELETE FROM items WHERE id = ?", itemId);
		assertThat(old.queryForObject("SELECT COUNT(*) FROM analyses", Integer.class)).isZero();
	}

	@Test
	void createsIndexesAndUniqueConstraints() {
		List<String> indexes = jdbc.queryForList(
				"SELECT DISTINCT index_name FROM information_schema.statistics WHERE table_schema = DATABASE()",
				String.class);
		assertThat(indexes).contains("idx_items_auction_date", "idx_items_usage_type", "idx_items_min_bid_price",
				"idx_analyses_item_id", "idx_item_changes_item_id", "idx_worker_runs_worker_started_at",
				"uq_items_court_case_item", "uq_item_photos_item_seq");
	}

	@Test
	void reapplyingToUpToDateDatabaseChangesNothing() {
		jdbc.update("INSERT INTO collector_state (`key`, value, updated_at) VALUES ('k', 'v', NOW(3))");
		Flyway flyway = Flyway.configure()
				.dataSource(MySqlTestContainer.MYSQL.getJdbcUrl(), MySqlTestContainer.MYSQL.getUsername(),
						MySqlTestContainer.MYSQL.getPassword())
				.locations("classpath:db/migration").load();
		assertThat(flyway.migrate().migrationsExecuted).isZero();
		assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM collector_state", Integer.class)).isEqualTo(1);
	}

	@Test
	void tamperedMigrationIsRejectedByFlywayValidate() throws SQLException {
		String db = freshDatabase();
		Flyway flyway = flywayFor(db);
		flyway.migrate();
		flyway.validate();

		new JdbcTemplate(dataSourceFor(db)).update("UPDATE flyway_schema_history SET checksum = 12345 WHERE version = '1'");

		assertThatThrownBy(flyway::validate).isInstanceOf(FlywayValidateException.class)
				.hasMessageContaining("checksum");
	}

	@Test
	void applicationRefusesToStartWhenAppliedMigrationWasTampered() {
		String db = freshDatabase();
		flywayFor(db).migrate();
		new JdbcTemplate(dataSourceFor(db)).update("UPDATE flyway_schema_history SET checksum = 12345 WHERE version = '1'");

		SpringApplicationBuilder app = new SpringApplicationBuilder(BackendApplication.class)
				.web(WebApplicationType.NONE)
				.properties("spring.datasource.url=" + urlFor(db),
						"spring.datasource.username=root",
						"spring.datasource.password=" + MySqlTestContainer.MYSQL.getPassword(),
						"spring.jpa.hibernate.ddl-auto=none");
		assertThatThrownBy(() -> app.run()).hasStackTraceContaining("FlywayValidateException");
	}

	private String freshDatabase() {
		String db = "tamper_" + UUID.randomUUID().toString().replace("-", "").substring(0, 12);
		new JdbcTemplate(rootDataSource()).execute("CREATE DATABASE " + db);
		return db;
	}

	private DriverManagerDataSource rootDataSource() {
		return new DriverManagerDataSource(MySqlTestContainer.MYSQL.getJdbcUrl(), "root",
				MySqlTestContainer.MYSQL.getPassword());
	}

	private String urlFor(String db) {
		return "jdbc:mysql://" + MySqlTestContainer.MYSQL.getHost() + ":" + MySqlTestContainer.MYSQL.getFirstMappedPort() + "/" + db;
	}

	private DriverManagerDataSource dataSourceFor(String db) {
		return new DriverManagerDataSource(urlFor(db), "root", MySqlTestContainer.MYSQL.getPassword());
	}

	private Flyway flywayFor(String db) {
		return Flyway.configure().dataSource(dataSourceFor(db)).locations("classpath:db/migration").load();
	}

}
