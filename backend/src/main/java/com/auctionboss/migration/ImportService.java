package com.auctionboss.migration;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.time.LocalDateTime;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import javax.sql.DataSource;

import com.auctionboss.collect.collector.CollectorRun;
import com.auctionboss.collect.photos.PhotoRun;
import com.auctionboss.collect.run.RunLock;
import com.auctionboss.common.time.ServerClock;
import com.auctionboss.photo.PhotoFileStore;
import org.flywaydb.core.Flyway;
import org.flywaydb.core.api.MigrationInfo;
import org.flywaydb.core.api.MigrationInfoService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.core.io.ByteArrayResource;
import org.springframework.core.io.FileSystemResource;
import org.springframework.core.io.support.EncodedResource;
import org.springframework.jdbc.datasource.init.ScriptException;
import org.springframework.jdbc.datasource.init.ScriptUtils;
import org.springframework.stereotype.Component;

/**
 * 운영 데이터 가져오기(migrate-data-and-cutover D5). TS 내보내기가 쓴 SQL을 MySQL에 한 트랜잭션으로 적재하고, 같은 규칙으로 MySQL에서
 * 해시를 다시 계산해 매니페스트와 대조한다.
 *
 * <p>
 * 순서: 입력 확인 → Flyway 최신 확인 → 컬럼 집합 비교 → 수집·사진 잠금({@code GET_LOCK}, 기다리지 않음) → 트랜잭션 → 대상이 비어 있는지
 * (아니면 {@code replace}일 때만 FK 역순 {@code DELETE}) → SQL 실행 → 행 수·해시 대조 → 사진 복사·대조 → 이전 완료 표식 → 커밋(드라이런은
 * 롤백) → {@code AUTO_INCREMENT} 설정. {@code TRUNCATE}는 암묵적 커밋이라 쓰지 않는다. 어디서 실패해도 대상 데이터베이스는 이전 전 상태이고 새로
 * 복사한 사진 파일은 지워진다. 보고에는 테이블 이름, 건수, 해시, 시간, 컬럼 이름만 쓴다(값 없음).
 */
@Component
public class ImportService {

	private static final Logger log = LoggerFactory.getLogger(ImportService.class);

	/** FK 순서. 지울 때는 거꾸로 간다. */
	static final List<String> TABLES = List.of("items", "item_changes", "analyses", "worker_runs", "bookmarks",
			"feed_reads", "collector_state", "item_photos");

	private static final Pattern COLUMN = Pattern.compile("column '([A-Za-z0-9_]+)'", Pattern.CASE_INSENSITIVE);

	private static final Pattern CONSTRAINT = Pattern.compile("(?:check constraint|CONSTRAINT) [`']([A-Za-z0-9_]+)[`']",
			Pattern.CASE_INSENSITIVE);

	private static final Pattern KEY = Pattern.compile("for key '([A-Za-z0-9_.]+)'", Pattern.CASE_INSENSITIVE);

	private final DataSource dataSource;

	private final Flyway flyway;

	private final RunLock lock;

	private final PhotoFileStore photoStore;

	private final ServerClock clock;

	private final ObjectProvider<ImportHook> hooks;

	ImportService(DataSource dataSource, Flyway flyway, RunLock lock, PhotoFileStore photoStore, ServerClock clock,
			ObjectProvider<ImportHook> hooks) {
		this.dataSource = dataSource;
		this.flyway = flyway;
		this.lock = lock;
		this.photoStore = photoStore;
		this.clock = clock;
		this.hooks = hooks;
	}

	public ImportReport run(ImportOptions options) {
		ImportReport report = new ImportReport();
		long started = System.nanoTime();
		report.line("가져오기 시작: 드라이런 %s, 교체 %s", options.dryRun(), options.replace());
		try {
			execute(options, report);
			report.succeeded();
		}
		catch (ImportFailure e) {
			report.line("실패: %s", e.getMessage());
		}
		catch (SQLException e) {
			report.line("실패: 데이터베이스 오류 %s", describe(e));
		}
		catch (UncheckedIOException e) {
			report.line("실패: 파일 입출력 오류 (%s)", e.getCause().getClass().getSimpleName());
		}
		catch (RuntimeException e) {
			// 예외 메시지에는 값이 들어 있을 수 있어 종류만 남긴다.
			// 스택 추적은 남기되 메시지(값이 들어 있을 수 있음)는 남기지 않는다: 메시지 없는 같은 종류의 예외로 바꿔 기록한다.
			RuntimeException redacted = new RuntimeException(e.getClass().getName());
			redacted.setStackTrace(e.getStackTrace());
			log.error("[import] 예기치 않은 오류 ({})", e.getClass().getSimpleName(), redacted);
			report.line("실패: 예기치 않은 오류 (%s)", e.getClass().getSimpleName());
		}
		report.line("%s (%d ms)", report.success() ? "성공" : "실패 - 대상 데이터베이스는 이전 전 상태입니다",
				(System.nanoTime() - started) / 1_000_000);
		return report;
	}

	private void execute(ImportOptions options, ImportReport report) throws SQLException {
		MigrationManifest manifest = readManifest(options.dir());
		checkFlyway(report);
		checkColumns(manifest, report);
		try (RunLock.Held collector = acquire(CollectorRun.LOCK_NAME);
				RunLock.Held photos = acquire(PhotoRun.LOCK_NAME)) {
			report.line("수집·사진 잠금을 얻었습니다");
			Path tempPhotos = null;
			PhotoImporter.Applied applied = null;
			try (Connection connection = dataSource.getConnection()) {
				boolean committed = false;
				connection.setAutoCommit(false);
				try {
					checkTarget(connection, options, report);
					load(connection, manifest, options.dir(), report);
					for (ImportHook hook : hooks.orderedStream().toList()) {
						hook.afterLoad(connection);
					}
					verify(connection, manifest, options.dir(), report);
					checkPhotoRecords(connection, manifest);
					PhotoFileStore target = photoStore;
					if (options.dryRun()) {
						tempPhotos = Files.createTempDirectory("auctionboss-import-photos-");
						target = new PhotoFileStore(tempPhotos.toString());
					}
					applied = PhotoImporter.copy(options.dir().resolve("photos"), manifest.photos(), target,
							options.replace());
					for (ImportHook hook : hooks.orderedStream().toList()) {
						hook.afterPhotosCopied(tempPhotos != null ? tempPhotos : photoStore.locate(".").orElseThrow());
					}
					PhotoImporter.verify(manifest.photos(), target);
					report.line("사진 %d개 확인(새로 복사 %d, 이미 같은 파일 %d), 기록 없는 파일 %d개는 옮기지 않음",
							manifest.photos().size(), applied.copied, applied.unchanged, manifest.orphans());
					MigrationMarker.write(connection, markerValue(manifest), LocalDateTime.ofInstant(clock.now(), ZoneOffset.UTC));
					if (options.dryRun()) {
						connection.rollback();
						report.line("드라이런: 롤백했습니다(표식과 사진 파일은 남기지 않음)");
					}
					else {
						connection.commit();
						committed = true;
					}
				}
				finally {
					if (!committed) {
						rollbackQuietly(connection);
						if (applied != null) {
							applied.undo();
						}
					}
					if (tempPhotos != null) {
						deleteTree(tempPhotos);
					}
				}
				if (committed) {
					connection.setAutoCommit(true);
					setAutoIncrement(connection, manifest, report);
				}
			}
			catch (IOException e) {
				throw new UncheckedIOException(e);
			}
		}
	}

	// --- 입력·사전 확인 -------------------------------------------------------------------------------------

	private MigrationManifest readManifest(Path dir) {
		Path file = dir.resolve("manifest.json");
		if (!Files.isRegularFile(file)) {
			throw new ImportFailure("가져오기 디렉터리에 manifest.json이 없습니다");
		}
		MigrationManifest manifest = MigrationManifest.read(file);
		if (manifest.ruleVersion() != RowNormalizer.RULE_VERSION) {
			throw new ImportFailure("정규화 규칙 버전이 다릅니다: 매니페스트 " + manifest.ruleVersion() + ", 가져오기 "
					+ RowNormalizer.RULE_VERSION);
		}
		for (String table : TABLES) {
			MigrationManifest.Table t = manifest.tables().get(table);
			if (t == null) {
				throw new ImportFailure("매니페스트에 테이블이 없습니다: " + table);
			}
			if (t.rows() > 0 && (t.file() == null || !Files.isRegularFile(sqlFile(dir, t)))) {
				throw new ImportFailure("SQL 파일이 없습니다: " + table);
			}
		}
		return manifest;
	}

	/** 내보내기 출력은 SQL을 디렉터리 바로 아래에 쓴다. 교차 언어 골든은 {@code sql/} 아래에 둔다 - 둘 다 받는다. */
	private static Path sqlFile(Path dir, MigrationManifest.Table table) {
		Path direct = dir.resolve(table.file());
		return Files.isRegularFile(direct) ? direct : dir.resolve("sql").resolve(table.file());
	}

	private void checkFlyway(ImportReport report) {
		MigrationInfoService info = flyway.info();
		MigrationInfo[] all = info.all();
		for (MigrationInfo m : all) {
			if (m.getState().isFailed()) {
				throw new ImportFailure("Flyway 마이그레이션이 실패 상태입니다: " + m.getVersion());
			}
		}
		MigrationInfo current = info.current();
		if (info.pending().length > 0 || current == null || all.length == 0
				|| !current.getVersion().equals(all[all.length - 1].getVersion())) {
			throw new ImportFailure("Flyway 스키마가 최신이 아닙니다");
		}
		report.line("Flyway 최신 확인: V%s", current.getVersion());
	}

	private void checkColumns(MigrationManifest manifest, ImportReport report) throws SQLException {
		try (Connection connection = dataSource.getConnection()) {
			for (String table : TABLES) {
				Set<String> actual = new HashSet<>();
				try (PreparedStatement st = connection.prepareStatement(
						"SELECT column_name AS n FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ?")) {
					st.setString(1, table);
					try (ResultSet rs = st.executeQuery()) {
						while (rs.next()) {
							actual.add(rs.getString("n"));
						}
					}
				}
				Set<String> expected = new HashSet<>(manifest.tables().get(table).columns());
				if (!actual.equals(expected)) {
					Set<String> onlyTarget = new HashSet<>(actual);
					onlyTarget.removeAll(expected);
					Set<String> onlyManifest = new HashSet<>(expected);
					onlyManifest.removeAll(actual);
					throw new ImportFailure("컬럼 집합이 다릅니다: " + table + " 대상에만 " + sorted(onlyTarget) + ", 매니페스트에만 "
							+ sorted(onlyManifest));
				}
			}
		}
		report.line("컬럼 집합 확인: 8개 테이블 일치");
	}

	private RunLock.Held acquire(String name) {
		return lock.tryAcquire(name)
			.orElseThrow(() -> new ImportFailure("다른 연결이 잠금을 쥐고 있어 중단합니다: " + name
					+ " (수집·사진 워커가 돌고 있지 않은지 확인하세요)"));
	}

	private void checkTarget(Connection connection, ImportOptions options, ImportReport report) throws SQLException {
		Map<String, Long> counts = new LinkedHashMap<>();
		for (String table : TABLES) {
			counts.put(table, count(connection, table));
		}
		boolean empty = counts.values().stream().allMatch(n -> n == 0);
		if (empty) {
			report.line("대상 데이터베이스가 비어 있습니다");
			return;
		}
		Map<String, Long> nonEmpty = new LinkedHashMap<>();
		counts.forEach((t, n) -> {
			if (n > 0) {
				nonEmpty.put(t, n);
			}
		});
		if (!options.replace()) {
			throw new ImportFailure("대상 테이블에 행이 있어 거부합니다(교체하려면 auctionboss.import.replace=true): " + nonEmpty);
		}
		report.line("교체: 대상의 기존 행을 FK 역순으로 지웁니다 %s", nonEmpty);
		for (int i = TABLES.size() - 1; i >= 0; i--) {
			try (Statement st = connection.createStatement()) {
				st.executeUpdate("DELETE FROM `" + TABLES.get(i) + "`");
			}
		}
	}

	private static long count(Connection connection, String table) throws SQLException {
		try (Statement st = connection.createStatement();
				ResultSet rs = st.executeQuery("SELECT COUNT(*) FROM `" + table + "`")) {
			rs.next();
			return rs.getLong(1);
		}
	}

	// --- 적재·검증 ----------------------------------------------------------------------------------------

	private void load(Connection connection, MigrationManifest manifest, Path dir, ImportReport report) {
		for (String table : TABLES) {
			MigrationManifest.Table t = manifest.tables().get(table);
			if (t.rows() == 0) {
				continue;
			}
			try {
				ScriptUtils.executeSqlScript(connection, new EncodedResource(new FileSystemResource(sqlFile(dir, t)),
						StandardCharsets.UTF_8));
			}
			catch (ScriptException e) {
				throw new ImportFailure("SQL 적재에 실패했습니다: 테이블 " + table + describeCause(e));
			}
			report.line("적재: %s", table);
		}
	}

	private void verify(Connection connection, MigrationManifest manifest, Path dir, ImportReport report)
			throws SQLException {
		List<String> mismatched = new ArrayList<>();
		for (String table : TABLES) {
			MigrationManifest.Table expected = manifest.tables().get(table);
			TableDigest.Result actual;
			try {
				actual = TableDigest.compute(connection, table, expected.columns());
			}
			catch (IllegalArgumentException e) {
				throw new ImportFailure("대상 값을 정규화할 수 없습니다: 테이블 " + table);
			}
			boolean same = actual.rows() == expected.rows() && actual.sha256().equals(expected.sha256());
			report.line("검증 %s: 행 %d/%d, sha256 %s %s", table, actual.rows(), expected.rows(), actual.sha256(),
					same ? "일치" : "불일치(매니페스트 " + expected.sha256() + ")");
			if (!same) {
				mismatched.add(table);
				report.line("  %s", firstDifference(connection, table, expected, dir));
			}
		}
		if (!mismatched.isEmpty()) {
			throw new ImportFailure("해시 대조가 일치하지 않습니다: " + mismatched);
		}
	}

	/**
	 * 처음으로 다른 행의 키와 컬럼 이름을 찾는다(값은 쓰지 않는다). 같은 SQL을 임시 테이블에 다시 적재해(임시 테이블 생성은 암묵적 커밋이
	 * 아니다) 실제 테이블과 행 단위로 비교한다.
	 */
	private String firstDifference(Connection connection, String table, MigrationManifest.Table expected, Path dir) {
		String temp = "__import_cmp_" + table;
		try {
			try (Statement st = connection.createStatement()) {
				st.execute("CREATE TEMPORARY TABLE `" + temp + "` LIKE `" + table + "`");
			}
			try {
				if (expected.rows() > 0) {
					String sql = Files.readString(sqlFile(dir, expected), StandardCharsets.UTF_8)
						.replace("INSERT INTO `" + table + "`", "INSERT INTO `" + temp + "`");
					ScriptUtils.executeSqlScript(connection,
							new EncodedResource(new ByteArrayResource(sql.getBytes(StandardCharsets.UTF_8)), StandardCharsets.UTF_8));
				}
				List<TableDigest.Column> columns = TableDigest.columns(connection, table, expected.columns());
				List<TableDigest.Row> actual = TableDigest.rows(connection, table, table, columns);
				List<TableDigest.Row> wanted = TableDigest.rows(connection, table, temp, columns);
				Map<String, TableDigest.Row> wantedByKey = new HashMap<>();
				wanted.forEach(r -> wantedByKey.put(r.key(), r));
				Map<String, TableDigest.Row> actualByKey = new HashMap<>();
				actual.forEach(r -> actualByKey.put(r.key(), r));
				for (TableDigest.Row row : actual) {
					TableDigest.Row other = wantedByKey.get(row.key());
					if (other == null) {
						return "처음 다른 행: 키 " + row.key() + " (매니페스트 SQL에 없는 행)";
					}
					for (int i = 0; i < columns.size(); i++) {
						if (!java.util.Objects.equals(row.values().get(i), other.values().get(i))) {
							return "처음 다른 행: 키 " + row.key() + ", 컬럼 " + columns.get(i).name();
						}
					}
				}
				for (TableDigest.Row row : wanted) {
					if (!actualByKey.containsKey(row.key())) {
						return "처음 다른 행: 키 " + row.key() + " (대상에 없는 행)";
					}
				}
				return "행 단위 차이 없음(적재한 SQL과 같은 값) - 매니페스트가 SQL과 어긋났거나 두 구현의 정규화 규칙이 다를 수 있습니다";
			}
			finally {
				try (Statement st = connection.createStatement()) {
					st.execute("DROP TEMPORARY TABLE IF EXISTS `" + temp + "`");
				}
			}
		}
		catch (SQLException | IOException | RuntimeException e) {
			return "행 단위 비교를 하지 못했습니다";
		}
	}

	/** 사진 기록(item_photos.file_path)과 매니페스트의 사진 목록이 같은지 본다. 어긋나면 id만 알린다. */
	private void checkPhotoRecords(Connection connection, MigrationManifest manifest) throws SQLException {
		Set<String> listed = new HashSet<>();
		manifest.photos().forEach(p -> listed.add(p.path()));
		Set<String> recorded = new HashSet<>();
		List<Long> unlisted = new ArrayList<>();
		try (Statement st = connection.createStatement();
				ResultSet rs = st.executeQuery("SELECT id, file_path FROM item_photos")) {
			while (rs.next()) {
				recorded.add(rs.getString("file_path"));
				if (!listed.contains(rs.getString("file_path"))) {
					unlisted.add(rs.getLong("id"));
				}
			}
		}
		if (!unlisted.isEmpty()) {
			throw new ImportFailure("매니페스트에 없는 사진 파일을 가리키는 item_photos 행이 있습니다: id " + unlisted);
		}
		long extra = listed.stream().filter(p -> !recorded.contains(p)).count();
		if (extra > 0) {
			throw new ImportFailure("어떤 item_photos 행도 가리키지 않는 사진 파일이 매니페스트에 " + extra + "개 있습니다");
		}
	}

	private static String markerValue(MigrationManifest manifest) {
		StringBuilder sb = new StringBuilder("{\"ruleVersion\":").append(manifest.ruleVersion()).append(",\"tables\":{");
		boolean first = true;
		for (String table : TABLES) {
			MigrationManifest.Table t = manifest.tables().get(table);
			sb.append(first ? "" : ",").append('"').append(table).append("\":{\"rows\":").append(t.rows())
				.append(",\"sha256\":\"").append(t.sha256()).append("\"}");
			first = false;
		}
		return sb.append("}}").toString();
	}

	// --- 커밋 뒤 ---------------------------------------------------------------------------------------------

	/** 테이블마다 {@code AUTO_INCREMENT = max(sqliteSeq, maxId) + 1}. 실패하면 이전은 커밋됐지만 시퀀스가 어긋난 것이므로 알린다. */
	private void setAutoIncrement(Connection connection, MigrationManifest manifest, ImportReport report) throws SQLException {
		Set<String> autoTables = new HashSet<>();
		try (Statement st = connection.createStatement();
				ResultSet rs = st.executeQuery("SELECT table_name AS t FROM information_schema.columns "
						+ "WHERE table_schema = DATABASE() AND extra LIKE '%auto_increment%'")) {
			while (rs.next()) {
				autoTables.add(rs.getString("t"));
			}
		}
		try (Statement st = connection.createStatement()) {
			st.execute("SET SESSION information_schema_stats_expiry = 0");
		}
		for (String table : TABLES) {
			if (!autoTables.contains(table)) {
				continue;
			}
			MigrationManifest.Table t = manifest.tables().get(table);
			long next = Math.max(t.sqliteSeq() == null ? 0 : t.sqliteSeq(), t.maxId() == null ? 0 : t.maxId()) + 1;
			try (Statement st = connection.createStatement()) {
				st.execute("ALTER TABLE `" + table + "` AUTO_INCREMENT = " + next);
			}
			long actual = autoIncrement(connection, table);
			if (actual < next) {
				throw new ImportFailure("이전은 커밋됐지만 AUTO_INCREMENT를 맞추지 못했습니다: " + table + " (필요 " + next + ", 현재 " + actual + ")");
			}
			report.line("AUTO_INCREMENT %s = %d", table, actual);
		}
	}

	private static long autoIncrement(Connection connection, String table) throws SQLException {
		try (PreparedStatement st = connection.prepareStatement(
				"SELECT auto_increment AS a FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?")) {
			st.setString(1, table);
			try (ResultSet rs = st.executeQuery()) {
				return rs.next() ? rs.getLong("a") : -1;
			}
		}
	}

	// --- 보조 -------------------------------------------------------------------------------------------------

	private static void rollbackQuietly(Connection connection) {
		try {
			connection.rollback();
		}
		catch (SQLException e) {
			log.warn("[import] 롤백 실패 - 연결이 닫히면 트랜잭션은 버려집니다");
		}
	}

	private static void deleteTree(Path root) {
		try (var walk = Files.walk(root)) {
			walk.sorted(java.util.Comparator.reverseOrder()).forEach(p -> {
				try {
					Files.deleteIfExists(p);
				}
				catch (IOException ignored) {
					// 임시 디렉터리 정리는 최대한만 한다
				}
			});
		}
		catch (IOException ignored) {
			// 위와 같다
		}
	}

	private static List<String> sorted(Set<String> set) {
		return set.stream().sorted().toList();
	}

	private static String describeCause(Throwable e) {
		for (Throwable t = e; t != null; t = t.getCause()) {
			if (t instanceof SQLException sql) {
				return " " + describe(sql);
			}
		}
		return "";
	}

	/** SQLException을 값 없는 설명으로 바꾼다: 오류 코드·SQLState와, 메시지에서 컬럼·제약·키 이름만 뽑는다(메시지에는 값이 있을 수 있다). */
	static String describe(SQLException e) {
		StringBuilder sb = new StringBuilder("(코드 ").append(e.getErrorCode()).append(", SQLState ").append(e.getSQLState());
		String message = e.getMessage() == null ? "" : e.getMessage();
		Optional.of(COLUMN.matcher(message)).filter(Matcher::find).ifPresent(m -> sb.append(", 컬럼 ").append(m.group(1)));
		Optional.of(CONSTRAINT.matcher(message)).filter(Matcher::find).ifPresent(m -> sb.append(", 제약 ").append(m.group(1)));
		Optional.of(KEY.matcher(message)).filter(Matcher::find).ifPresent(m -> sb.append(", 키 ").append(m.group(1)));
		return sb.append(')').toString();
	}

}
