package com.auctionboss.contract;

import static org.assertj.core.api.Assertions.assertThat;

import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.HexFormat;
import java.sql.ResultSet;
import java.sql.ResultSetMetaData;
import java.sql.SQLException;
import java.sql.Types;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDateTime;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.List;
import java.util.stream.Stream;

import com.auctionboss.collect.collector.CollectorRun;
import com.auctionboss.collect.photos.PhotoRun;
import com.auctionboss.collect.run.BackoffStore;
import com.auctionboss.collect.run.CollectorSettings;
import com.auctionboss.collect.run.RunLock;
import com.auctionboss.collect.run.WorkerTicker;
import com.auctionboss.collect.source.CollectScope;
import com.auctionboss.collect.source.CourtRef;
import com.auctionboss.collect.source.FetchActiveItemsResult;
import com.auctionboss.collect.source.FetchItemPhotosResult;
import com.auctionboss.collect.source.PhotoLookupRef;
import com.auctionboss.collect.source.SourcePhoto;
import com.auctionboss.collect.source.ResponseSchemaException;
import com.auctionboss.collect.source.RobotDetectedException;
import com.auctionboss.collect.source.SourceException;
import com.auctionboss.collect.source.SourceItem;
import com.auctionboss.collect.source.SourceRequestException;
import com.auctionboss.collect.source.WafBlockedException;
import com.auctionboss.support.AbstractPhotoTest;
import com.auctionboss.support.FakeSourceConfig.FakeAuctionSource;
import com.auctionboss.support.FakeSourceConfig.FakeSleeper;
import com.auctionboss.support.MutableClock;
import com.auctionboss.worker.WorkerRunService;
import org.junit.jupiter.api.DynamicTest;
import org.junit.jupiter.api.TestFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.core.io.ClassPathResource;
import tools.jackson.databind.DeserializationFeature;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;
import tools.jackson.databind.node.ArrayNode;
import tools.jackson.databind.node.ObjectNode;

/**
 * 저장 골든({@code contracts/collector/*.json}) 재생(4.6 수집, 6.4 사진). TS 워커가 임시 SQLite·임시 사진 디렉터리에 만든 결과를 Spring
 * {@link CollectorRun}·{@link PhotoRun}이 MySQL·임시 사진 디렉터리에 같은 입력으로 만드는지 단계마다 엄격 비교한다.
 *
 * <p>
 * 비교 대상: {@code items}(자동증가 {@code id} 포함)·{@code item_changes}·{@code worker_runs}·{@code collector_state}·
 * {@code item_photos}, 사진 파일(상대 경로·크기·SHA-256), 가짜 소스가 받은 호출(수집은 법원 순서, 사진은 대상 물건), 사진 단계의 대기 시간과
 * 틱 결과. 사진 단계도 실제 {@link PhotoRun}을 틱 경로({@link WorkerTicker}: 단일 실행 잠금, 백오프 확인, 전용 스레드 회차)로 재생하고, 골든
 * 상태를 DB에 심는 우회는 없다.
 */
class StoreContractTest extends AbstractPhotoTest {

	private static final JsonMapper JSON = JsonMapper.builder()
		.disable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES)
		.build();

	private static final DateTimeFormatter ISO_MILLIS = DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'")
		.withZone(ZoneOffset.UTC);

	static final List<String> SCENARIOS = List.of("collect-insert-baseline", "collect-update-change",
			"collect-duplicate-in-batch", "collect-rotation-budget", "collect-court-removed", "collect-blocked",
			"collect-failed", "photos-outcomes", "photos-blocked-and-retry", "shared-backoff");

	@Autowired
	CollectorRun collectorRun;

	@Autowired
	PhotoRun photoRun;

	@Autowired
	FakeSleeper sleeper;

	@Autowired
	BackoffStore backoff;

	/** 재생한 단계 수(시나리오 순서대로 실행되는 동적 테스트의 마지막이 합계를 확인한다). */
	private static final java.util.concurrent.atomic.AtomicInteger REPLAYED_STEPS = new java.util.concurrent.atomic.AtomicInteger();

	@Autowired
	RunLock runLock;

	@Autowired
	WorkerRunService runs;

	@Autowired
	FakeAuctionSource source;

	@Autowired
	MutableClock clock;

	@TestFactory
	Stream<DynamicTest> 저장_골든의_모든_시나리오가_단계마다_같다() {
		REPLAYED_STEPS.set(0);
		Stream<DynamicTest> scenarios = SCENARIOS.stream()
			.map(name -> DynamicTest.dynamicTest(name, () -> REPLAYED_STEPS.addAndGet(replay(name))));
		// 골든의 모든 단계를 빠짐없이 재생했는지(건너뛴 단계가 없는지) 마지막에 확인한다.
		DynamicTest total = DynamicTest.dynamicTest("모든 단계를 재생했다", () -> assertThat(REPLAYED_STEPS.get())
			.as("재생한 단계 수")
			.isEqualTo(goldenStepCount()));
		return Stream.concat(scenarios, Stream.of(total));
	}

	/** 골든 디렉터리에 있는 모든 파일의 단계 수 합계. 재생 목록({@link #SCENARIOS})이 아니라 디렉터리를 기준으로 센다. */
	private int goldenStepCount() throws IOException {
		var resources = new org.springframework.core.io.support.PathMatchingResourcePatternResolver()
			.getResources("classpath:contracts/collector/*.json");
		List<String> names = new ArrayList<>();
		int count = 0;
		for (var resource : resources) {
			names.add(resource.getFilename().replace(".json", ""));
			try (InputStream in = resource.getInputStream()) {
				count += JSON.readTree(in).get("steps").size();
			}
		}
		assertThat(SCENARIOS).as("재생 목록은 골든 디렉터리의 모든 시나리오와 같아야 한다").containsExactlyInAnyOrderElementsOf(names);
		return count;
	}

	/** 시나리오를 재생하고 재생한 단계 수를 돌려준다. */
	private int replay(String name) throws IOException {
		// 동적 테스트는 @BeforeEach가 한 번만 돈다: 시나리오 사이에 쓰기 대상 테이블을 직접 비운다.
		jdbc.update("DELETE FROM items");
		jdbc.update("DELETE FROM worker_runs");
		jdbc.update("DELETE FROM collector_state");
		for (String table : List.of("items", "item_changes", "worker_runs", "item_photos")) {
			jdbc.update("ALTER TABLE " + table + " AUTO_INCREMENT = 1");
		}
		source.reset();
		sleeper.reset();
		emptyPhotosDir();

		JsonNode golden;
		try (InputStream in = new ClassPathResource("contracts/collector/" + name + ".json").getInputStream()) {
			golden = JSON.readTree(in);
		}
		CollectorSettings.Scope defaultScope = scope(golden.get("config").get("scope"));
		JsonNode steps = golden.get("steps");
		for (int i = 0; i < steps.size(); i++) {
			JsonNode step = steps.get(i);
			JsonNode input = step.get("input");
			String label = name + " / " + step.get("label").asString();
			clock.set(Instant.parse(step.get("at").asString()));
			source.reset();
			sleeper.reset();

			switch (input.get("run").asString()) {
				case "collector" -> {
					scriptSearch(input.get("search"));
					tick("collector", "auctionboss.collector",
							() -> collectorRun.run(input.has("scope") ? scope(input.get("scope")) : defaultScope));
					assertCalls(label, step.get("calls"));
				}
				case "photos" -> {
					JsonNode config = input.has("photosConfig") ? input.get("photosConfig")
							: golden.get("config").get("photos");
					long before = maxRunId();
					scriptPhotos(input.get("results"));
					tick("photos", "auctionboss.photos", () -> photoRun.run(photos(config)));
					assertPhotoCalls(label, step.get("calls"));
					assertThat(source.photoCalls()).as(label + " 스크립트한 사진 결과를 모두 썼다").hasSize(scriptedPhotoResults);
					assertThat(ContractTest.diff("$.sleeps", step.get("sleeps"), sleepsAsJson()))
						.as(label + " 물건 사이 대기")
						.isNull();
					assertThat(tickResult(before)).as(label + " 틱 결과").isEqualTo(step.get("tickResult").asString());
				}
				case "prepare" -> prepare(input.get("op"));
				default -> throw new IllegalStateException("알 수 없는 단계: " + input.get("run"));
			}
			assertSnapshot(label, step.get("snapshot"));
		}
		return steps.size();
	}

	// ------------------------------------------------------------------ 단계 실행

	/** 실제 틱 경로: 단일 실행 잠금 -> 백오프 확인 -> 전용 스레드 회차. 회차가 끝나고 잠금이 풀릴 때까지 기다린다. */
	private void tick(String worker, String lockName, Runnable round) {
		WorkerTicker ticker = new WorkerTicker(worker, lockName, runLock, () -> backoff.remainingMs(clock.instant()),
				reason -> runs.recordSkipped(worker, reason), round);
		try {
			ticker.tick();
			assertThat(ticker.awaitIdle(Duration.ofSeconds(30))).as("회차가 끝나야 한다").isTrue();
		}
		finally {
			ticker.shutdown(Duration.ofSeconds(5));
		}
	}

	private long maxRunId() {
		return jdbc.queryForObject("SELECT COALESCE(MAX(id), 0) FROM worker_runs", Long.class);
	}

	/** TS {@code PhotoTickResult}: 이번 틱이 남긴 {@code worker_runs} 행의 결과(건너뜀 포함). */
	private String tickResult(long runIdBefore) {
		List<String> outcomes = jdbc.queryForList("SELECT outcome FROM worker_runs WHERE id > ? AND worker = 'photos'",
				String.class, runIdBefore);
		assertThat(outcomes).as("사진 틱 하나는 회차 행 하나를 남긴다").hasSize(1);
		return outcomes.get(0);
	}

	private int scriptedPhotoResults;

	private static CollectorSettings.Photos photos(JsonNode config) {
		return new CollectorSettings.Photos(config.get("intervalMs").asLong(), config.get("maxItemsPerRun").asLong(),
				config.get("requestDelayMs").asLong(), config.get("retryAfterHours").asLong());
	}

	private void prepare(JsonNode op) {
		String kind = op.get("kind").asString();
		if (kind.equals("extendBackoff")) {
			backoff.extend(Instant.parse(op.get("until").asString()));
		}
		else if (kind.equals("photoState")) {
			int changed = jdbc.update(
					"UPDATE items SET photo_status = ?, photo_attempted_at = ? WHERE court = ? AND case_no = ? AND item_no = ?",
					op.get("status").asString(),
					op.get("attemptedAt").isNull() ? null : utc(op.get("attemptedAt").asString()),
					op.get("court").asString(), op.get("caseNo").asString(), op.get("itemNo").asString());
			assertThat(changed).as("준비 작업 대상 물건").isEqualTo(1);
		}
		else {
			throw new IllegalStateException("알 수 없는 준비 작업: " + kind);
		}
	}

	/** 법원 코드 -> 그 법원 호출에 돌려줄 결과(물건과 요청 수, 또는 오류)를 가짜 소스에 정한다. */
	private void scriptSearch(JsonNode search) {
		source.onSearch(scope -> {
			CourtRef court = scope.courts().get(0);
			JsonNode result = search.get(court.courtCode());
			if (result == null) {
				throw new IllegalStateException("스크립트에 없는 법원 호출: " + court.courtCode());
			}
			if (result.has("error")) {
				throw error(result.get("error"));
			}
			List<SourceItem> items = new ArrayList<>();
			for (JsonNode item : result.get("items")) {
				items.add(JSON.treeToValue(item, SourceItem.class));
			}
			return new FetchActiveItemsResult(items, result.get("pagesRequested").asInt());
		});
	}

	private static SourceException error(JsonNode e) {
		String message = e.get("message").asString();
		SourceException error = switch (e.get("kind").asString()) {
			case "RobotDetectedError" -> new RobotDetectedException(message, null);
			case "WafBlockedError" -> new WafBlockedException(message, "");
			case "ResponseSchemaError" -> new ResponseSchemaException(message, List.of());
			case "SourceRequestError" -> new SourceRequestException(message, "http://loopback.invalid/");
			default -> throw new IllegalStateException("알 수 없는 오류 종류: " + e.get("kind"));
		};
		if (e.has("requestsMade")) {
			SourceException.attachRequestsMade(error, e.get("requestsMade").asInt());
		}
		return error;
	}

	/** 사진 조회 순서대로 돌려줄 결과(사진과 요청 수, 또는 오류)를 가짜 소스에 정한다. */
	private void scriptPhotos(JsonNode results) {
		scriptedPhotoResults = results.size();
		AtomicInteger next = new AtomicInteger();
		source.onPhotos(ref -> {
			int index = next.getAndIncrement();
			if (index >= results.size()) {
				throw new IllegalStateException("스크립트에 없는 사진 호출 " + (index + 1) + "번째");
			}
			JsonNode result = results.get(index);
			if (result.has("error")) {
				throw error(result.get("error"));
			}
			List<SourcePhoto> photos = new ArrayList<>();
			for (JsonNode photo : result.get("photos")) {
				photos.add(new SourcePhoto(photo.get("seq").asLong(), photo.get("base64").asString()));
			}
			return new FetchItemPhotosResult(photos, result.get("requestsMade").asInt());
		});
	}

	// ------------------------------------------------------------------ 비교

	private void assertCalls(String label, JsonNode expected) {
		ArrayNode actual = JSON.createArrayNode();
		for (CollectScope scope : source.searches()) {
			CourtRef court = scope.courts().get(0);
			ObjectNode call = JSON.createObjectNode();
			call.put("courtCode", court.courtCode());
			call.put("courtName", court.name());
			actual.add(call);
		}
		assertThat(ContractTest.diff("$.calls", expected, actual)).as(label + " 가짜 소스가 받은 호출").isNull();
	}

	private void assertPhotoCalls(String label, JsonNode expected) {
		ArrayNode actual = JSON.createArrayNode();
		for (PhotoLookupRef ref : source.photoCalls()) {
			ObjectNode call = JSON.createObjectNode();
			call.put("courtCode", ref.courtCode());
			call.put("internalCaseNo", ref.internalCaseNo());
			actual.add(call);
		}
		assertThat(ContractTest.diff("$.calls", expected, actual)).as(label + " 가짜 소스가 받은 사진 조회").isNull();
	}

	private ArrayNode sleepsAsJson() {
		ArrayNode actual = JSON.createArrayNode();
		sleeper.sleeps().forEach(actual::add);
		return actual;
	}

	/** 사진 디렉터리의 파일을 골든 {@code photoFiles}와 같은 형식(상대 경로 순, 크기, SHA-256)으로 만든다. */
	private ArrayNode photoFiles() {
		Path root = photosDir();
		List<Path> files;
		try (Stream<Path> walk = Files.walk(root)) {
			files = walk.filter(Files::isRegularFile).sorted().toList();
		}
		catch (IOException e) {
			throw new java.io.UncheckedIOException(e);
		}
		ArrayNode out = JSON.createArrayNode();
		for (Path file : files) {
			try {
				byte[] bytes = Files.readAllBytes(file);
				ObjectNode row = JSON.createObjectNode();
				row.put("path", root.relativize(file).toString().replace('\\', '/'));
				row.put("size", bytes.length);
				row.put("sha256", HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes)));
				out.add(row);
			}
			catch (IOException | java.security.NoSuchAlgorithmException e) {
				throw new IllegalStateException(e);
			}
		}
		return out;
	}

	private void assertSnapshot(String label, JsonNode snapshot) {
		assertTable(label, "items", snapshot, "items", "SELECT * FROM items ORDER BY id");
		assertTable(label, "itemChanges", snapshot, "itemChanges", "SELECT * FROM item_changes ORDER BY id");
		assertTable(label, "workerRuns", snapshot, "workerRuns", "SELECT * FROM worker_runs ORDER BY id");
		assertTable(label, "collectorState", snapshot, "collectorState",
				"SELECT * FROM collector_state ORDER BY `key`");
		assertTable(label, "itemPhotos", snapshot, "itemPhotos", "SELECT * FROM item_photos ORDER BY id");
		assertThat(ContractTest.diff("$.photoFiles", snapshot.get("photoFiles"), photoFiles()))
			.as(label + " 사진 파일(경로·크기·SHA-256)")
			.isNull();
	}

	private void assertTable(String label, String what, JsonNode snapshot, String field, String sql) {
		assertThat(ContractTest.diff("$." + what, snapshot.get(field), rows(sql))).as(label + " " + what).isNull();
	}

	/** 행을 골든 스냅숏과 같은 JSON으로 바꾼다: 시각은 밀리초 3자리 {@code Z}, 정수는 숫자, {@code detail}은 JSON. */
	private ArrayNode rows(String sql) {
		ArrayNode out = JSON.createArrayNode();
		jdbc.query(sql, (ResultSet rs) -> {
			ObjectNode row = JSON.createObjectNode();
			ResultSetMetaData meta = rs.getMetaData();
			for (int i = 1; i <= meta.getColumnCount(); i++) {
				put(row, meta.getColumnLabel(i), meta.getColumnType(i), rs, i);
			}
			out.add(row);
		});
		return out;
	}

	private static void put(ObjectNode row, String column, int type, ResultSet rs, int i) throws SQLException {
		Object raw = rs.getObject(i);
		if (raw == null) {
			row.putNull(column);
		}
		else if (type == Types.TIMESTAMP) {
			row.put(column, ISO_MILLIS.format(rs.getTimestamp(i).toInstant()));
		}
		else if (type == Types.BIGINT || type == Types.INTEGER || type == Types.SMALLINT) {
			row.put(column, rs.getLong(i));
		}
		else if (column.equals("detail")) {
			row.set(column, JSON.readTree(rs.getString(i)));
		}
		else {
			row.put(column, rs.getString(i));
		}
	}

	// ------------------------------------------------------------------ 변환

	private static CollectorSettings.Scope scope(JsonNode scope) {
		List<CourtRef> courts = new ArrayList<>();
		for (JsonNode court : scope.get("courts")) {
			courts.add(new CourtRef(court.get("name").asString(), court.get("courtCode").asString()));
		}
		return new CollectorSettings.Scope(courts, scope.get("maxCourtsPerRun").asLong(),
				scope.get("maxRequestsPerRun").asLong());
	}

	private static LocalDateTime utc(JsonNode iso) {
		return iso.isNull() ? null : utc(iso.asString());
	}

	private static LocalDateTime utc(String iso) {
		return LocalDateTime.ofInstant(Instant.parse(iso), ZoneOffset.UTC);
	}

	private static String text(JsonNode node) {
		return node.isNull() ? null : node.asString();
	}

}
