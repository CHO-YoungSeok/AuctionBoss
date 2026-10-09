package com.auctionboss.contract;

import static org.assertj.core.api.Assertions.assertThat;

import java.io.IOException;
import java.io.InputStream;
import java.sql.ResultSet;
import java.sql.ResultSetMetaData;
import java.sql.SQLException;
import java.sql.Types;
import java.time.Instant;
import java.time.LocalDateTime;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.stream.Stream;

import com.auctionboss.collect.collector.CollectorRun;
import com.auctionboss.collect.run.BackoffStore;
import com.auctionboss.collect.run.CollectorSettings;
import com.auctionboss.collect.source.CollectScope;
import com.auctionboss.collect.source.CourtRef;
import com.auctionboss.collect.source.FetchActiveItemsResult;
import com.auctionboss.collect.source.ResponseSchemaException;
import com.auctionboss.collect.source.RobotDetectedException;
import com.auctionboss.collect.source.SourceException;
import com.auctionboss.collect.source.SourceItem;
import com.auctionboss.collect.source.SourceRequestException;
import com.auctionboss.collect.source.WafBlockedException;
import com.auctionboss.support.AbstractMySqlTest;
import com.auctionboss.support.FakeSourceConfig;
import com.auctionboss.support.FakeSourceConfig.FakeAuctionSource;
import com.auctionboss.support.FixedClockConfig;
import com.auctionboss.support.MutableClock;
import com.auctionboss.worker.WorkerRunService;
import org.junit.jupiter.api.DynamicTest;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.context.annotation.Import;
import org.springframework.core.io.ClassPathResource;
import tools.jackson.databind.DeserializationFeature;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;
import tools.jackson.databind.node.ArrayNode;
import tools.jackson.databind.node.ObjectNode;

/**
 * 4.6: 저장 골든({@code contracts/collector/*.json}) 재생. TS 수집 워커가 임시 SQLite에 만든 결과를 Spring {@link CollectorRun}이
 * MySQL에 같은 입력으로 만드는지, 단계마다 {@code items}(자동증가 {@code id} 포함)·{@code item_changes}·{@code worker_runs}·
 * {@code collector_state}·{@code item_photos}를 엄격 비교한다. 단계마다 가짜 소스가 받은 호출(법원 순서)도 비교한다.
 *
 * <p>
 * 범위: {@code collect-*} 7개와 {@code shared-backoff}(수집 쪽). 사진 워커({@code PhotoRun})는 6장에서 만들므로
 * {@code shared-backoff}의 사진 단계는 재생하지 않고, 그 단계가 TS에서 남긴 사진 워커의 회차 행과 백오프를 골든 그대로 DB에 심는다
 * ({@link #injectPhotoStep}). 사진 단계 뒤의 수집 단계가 그 백오프를 지키는지(공유 백오프)를 이 방식으로 확인하고, 마지막 사진 단계(수집
 * 단계 뒤)는 6.4가 재생한다.
 *
 * <p>
 * 틱: 겹침·잠금은 5장이라 아직 없다. {@link #tick}이 TS 틱의 "백오프가 남았으면 {@code skipped(backoff)}, 아니면 회차" 부분만 그대로
 * 한다(5.2의 {@code WorkerTicker}가 생기면 그것으로 바꾼다).
 */
@Import({ FixedClockConfig.class, FakeSourceConfig.class })
class StoreContractTest extends AbstractMySqlTest {

	private static final JsonMapper JSON = JsonMapper.builder()
		.disable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES)
		.build();

	private static final DateTimeFormatter ISO_MILLIS = DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'")
		.withZone(ZoneOffset.UTC);

	static final List<String> SCENARIOS = List.of("collect-insert-baseline", "collect-update-change",
			"collect-duplicate-in-batch", "collect-rotation-budget", "collect-court-removed", "collect-blocked",
			"collect-failed", "shared-backoff");

	@Autowired
	CollectorRun collectorRun;

	@Autowired
	BackoffStore backoff;

	@Autowired
	WorkerRunService runs;

	@Autowired
	FakeAuctionSource source;

	@Autowired
	MutableClock clock;

	@TestFactory
	Stream<DynamicTest> 저장_골든의_모든_수집_시나리오가_단계마다_같다() {
		return SCENARIOS.stream().map(name -> DynamicTest.dynamicTest(name, () -> replay(name)));
	}

	private void replay(String name) throws IOException {
		// 동적 테스트는 @BeforeEach가 한 번만 돈다: 시나리오 사이에 쓰기 대상 테이블을 직접 비운다.
		jdbc.update("DELETE FROM items");
		jdbc.update("DELETE FROM worker_runs");
		jdbc.update("DELETE FROM collector_state");
		for (String table : List.of("items", "item_changes", "worker_runs", "item_photos")) {
			jdbc.update("ALTER TABLE " + table + " AUTO_INCREMENT = 1");
		}
		source.reset();

		JsonNode golden;
		try (InputStream in = new ClassPathResource("contracts/collector/" + name + ".json").getInputStream()) {
			golden = JSON.readTree(in);
		}
		CollectorSettings.Scope defaultScope = scope(golden.get("config").get("scope"));
		JsonNode steps = golden.get("steps");
		int last = -1;
		for (int i = 0; i < steps.size(); i++) {
			if (!"photos".equals(steps.get(i).get("input").get("run").asString())) {
				last = i;
			}
		}
		for (int i = 0; i <= last; i++) {
			JsonNode step = steps.get(i);
			JsonNode input = step.get("input");
			String label = name + " / " + step.get("label").asString();
			clock.set(Instant.parse(step.get("at").asString()));
			source.reset();

			switch (input.get("run").asString()) {
				case "collector" -> {
					script(input.get("search"));
					tick(input.has("scope") ? scope(input.get("scope")) : defaultScope);
					assertCalls(label, step.get("calls"));
				}
				case "prepare" -> prepare(input.get("op"));
				case "photos" -> {
					injectPhotoStep(step);
					continue;
				}
				default -> throw new IllegalStateException("알 수 없는 단계: " + input.get("run"));
			}
			assertSnapshot(label, step.get("snapshot"));
		}
	}

	// ------------------------------------------------------------------ 단계 실행

	private void tick(CollectorSettings.Scope scope) {
		if (backoff.remainingMs(clock.instant()) > 0) {
			runs.recordSkipped("collector", "backoff");
		}
		else {
			collectorRun.run(scope);
		}
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
	private void script(JsonNode search) {
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

	/**
	 * 사진 단계가 TS에서 남긴 효과를 심는다: 그 단계가 만든 사진 워커의 {@code worker_runs} 행(골든의 id·값 그대로)과, 있으면 공유
	 * 백오프 행. 사진 워커 코드는 돌리지 않는다.
	 */
	private void injectPhotoStep(JsonNode step) {
		JsonNode snapshot = step.get("snapshot");
		Set<Long> existing = new HashSet<>(jdbc.queryForList("SELECT id FROM worker_runs", Long.class));
		for (JsonNode row : snapshot.get("workerRuns")) {
			if (!row.get("worker").asString().equals("photos") || existing.contains(row.get("id").asLong())) {
				continue;
			}
			jdbc.update("""
					INSERT INTO worker_runs (id, worker, started_at, finished_at, outcome, error_kind, error_message,
					                         detail, items_changed, created_at)
					VALUES (?, ?, ?, ?, ?, ?, ?, CAST(? AS JSON), ?, ?)""", row.get("id").asLong(),
					row.get("worker").asString(), utc(row.get("started_at")), utc(row.get("finished_at")),
					row.get("outcome").asString(), text(row.get("error_kind")), text(row.get("error_message")),
					row.get("detail").isNull() ? null : row.get("detail").toString(),
					row.get("items_changed").isNull() ? null : row.get("items_changed").asInt(),
					utc(row.get("created_at")));
		}
		for (JsonNode state : snapshot.get("collectorState")) {
			if (state.get("key").asString().equals(BackoffStore.KEY)) {
				jdbc.update("""
						INSERT INTO collector_state (`key`, value, updated_at) VALUES (?, ?, ?)
						ON DUPLICATE KEY UPDATE value = VALUES(value), updated_at = VALUES(updated_at)""",
						state.get("key").asString(), state.get("value").asString(), utc(state.get("updated_at")));
			}
		}
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

	private void assertSnapshot(String label, JsonNode snapshot) {
		assertTable(label, "items", snapshot, "items", "SELECT * FROM items ORDER BY id");
		assertTable(label, "itemChanges", snapshot, "itemChanges", "SELECT * FROM item_changes ORDER BY id");
		assertTable(label, "workerRuns", snapshot, "workerRuns", "SELECT * FROM worker_runs ORDER BY id");
		assertTable(label, "collectorState", snapshot, "collectorState",
				"SELECT * FROM collector_state ORDER BY `key`");
		assertTable(label, "itemPhotos", snapshot, "itemPhotos", "SELECT * FROM item_photos ORDER BY id");
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

	@Test
	void 공유_백오프_시나리오는_사진_단계와_수집_단계를_함께_담고_있다() throws IOException {
		// 재생 범위 가정(사진 단계는 심기만 한다)이 골든 구성과 어긋나면 알린다.
		try (InputStream in = new ClassPathResource("contracts/collector/shared-backoff.json").getInputStream()) {
			List<String> kinds = new ArrayList<>();
			JSON.readTree(in).get("steps").forEach(s -> kinds.add(s.get("input").get("run").asString()));
			assertThat(kinds).contains("photos", "collector");
			assertThat(kinds.get(kinds.size() - 1)).as("마지막 사진 단계는 6.4가 재생한다").isEqualTo("photos");
		}
	}

}
