package com.auctionboss.worker;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.patch;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.time.Instant;
import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import com.auctionboss.support.AbstractMySqlTest;
import com.auctionboss.support.FixedClockConfig;
import com.auctionboss.support.MutableClock;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.context.annotation.Import;
import org.springframework.http.MediaType;
import org.springframework.test.context.TestPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/** 3.3 ~ 3.5: 회차 시작·정리, 종료, 목록. 보관 상한은 3으로 둔다. */
@AutoConfigureMockMvc
@Import(FixedClockConfig.class)
@TestPropertySource(properties = "auctionboss.worker.max-runs-per-worker=3")
class WorkerRunApiTest extends AbstractMySqlTest {

	private static final JsonMapper JSON = JsonMapper.builder().build();

	private static final Instant T0 = Instant.parse("2026-10-08T00:00:00Z");

	private static final String ANALYZER_DETAIL = "{\"newCount\":2,\"reanalysisCount\":1,\"succeeded\":3,\"failed\":0}";

	private static final String COLLECTOR_DETAIL = "{\"targetCourts\":[\"서울중앙지방법원\"],\"pagesRequested\":4,"
			+ "\"itemsFetched\":40,\"inserted\":3,\"updated\":7,\"changed\":5}";

	@Autowired
	MockMvc mvc;
	@Autowired
	MutableClock clock;

	@BeforeEach
	void resetClock() {
		clock.set(T0);
	}

	private JsonNode perform(MockHttpServletRequestBuilder request, int expectedStatus) throws Exception {
		var result = mvc.perform(request).andExpect(status().is(expectedStatus)).andReturn();
		return JSON.readTree(result.getResponse().getContentAsString());
	}

	private long start(String worker) throws Exception {
		return perform(post("/api/worker-runs").contentType(MediaType.APPLICATION_JSON)
				.content("{\"worker\":\"" + worker + "\"}"), 201).get("id").asLong();
	}

	private JsonNode finish(long id, String body, int expectedStatus) throws Exception {
		return perform(patch("/api/worker-runs/" + id).contentType(MediaType.APPLICATION_JSON).content(body),
				expectedStatus);
	}

	private List<Long> runIds(String worker) {
		return jdbc.queryForList("SELECT id FROM worker_runs WHERE worker = ? ORDER BY id", Long.class, worker);
	}

	private void at(String iso) {
		clock.set(Instant.parse(iso));
	}

	// ---- 3.3 시작과 보관 상한 정리 ----

	@Test
	void startCreatesARunningRowWithServerTimeForStartedAndCreatedAt() throws Exception {
		clock.set(Instant.parse("2026-10-08T01:02:03.456789Z"));

		JsonNode started = perform(post("/api/worker-runs").content("{\"worker\":\"analyzer\"}"), 201);

		assertThat(started.propertyNames()).containsExactly("id");
		Map<String, Object> row = jdbc.queryForMap("SELECT * FROM worker_runs WHERE id = ?", started.get("id").asLong());
		assertThat(row.get("worker")).isEqualTo("analyzer");
		assertThat(row.get("outcome")).isEqualTo("running");
		assertThat(row.get("finished_at")).isNull();
		assertThat(row.get("started_at")).isEqualTo(LocalDateTime.parse("2026-10-08T01:02:03.456"));
		assertThat(row.get("created_at")).isEqualTo(row.get("started_at"));
	}

	@Test
	void startRejectsUnknownWorkersAndBadBodies() throws Exception {
		JsonNode unknown = perform(post("/api/worker-runs").content("{\"worker\":\"scraper\"}"), 400);
		assertThat(unknown.get("error").asString()).isEqualTo("잘못된 회차 시작 본문입니다");
		assertThat(unknown.get("details").get(0).get("field").asString()).isEqualTo("worker");

		JsonNode missing = perform(post("/api/worker-runs").content("{}"), 400);
		assertThat(missing.get("details").get(0).get("field").asString()).isEqualTo("worker");

		JsonNode array = perform(post("/api/worker-runs").content("[]"), 400);
		assertThat(array.get("details").get(0).get("field").asString()).isEqualTo("(root)");

		JsonNode garbage = perform(post("/api/worker-runs").content("이건 JSON이 아니다"), 400);
		assertThat(garbage.get("error").asString()).isEqualTo("JSON 본문을 해석할 수 없습니다");
		assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM worker_runs", Long.class)).isZero();
	}

	@Test
	void startingAFourthRunAtTheLimitOfThreeDeletesOnlyTheOldestOfThatWorker() throws Exception {
		long other = start("collector");
		List<Long> analyzer = new ArrayList<>();
		for (int i = 0; i < 3; i++) {
			clock.set(T0.plusSeconds(10 + i));
			analyzer.add(start("analyzer"));
		}
		assertThat(runIds("analyzer")).isEqualTo(analyzer);

		clock.set(T0.plusSeconds(20));
		long fourth = start("analyzer");

		assertThat(runIds("analyzer")).containsExactly(analyzer.get(1), analyzer.get(2), fourth);
		assertThat(runIds("collector")).containsExactly(other);
	}

	@Test
	void runsWithTheSameStartedAtAreDeletedLowestIdFirst() throws Exception {
		// 시계를 움직이지 않아 네 회차의 started_at이 모두 같다.
		List<Long> ids = new ArrayList<>();
		for (int i = 0; i < 4; i++) {
			ids.add(start("photos"));
		}

		assertThat(runIds("photos")).containsExactly(ids.get(1), ids.get(2), ids.get(3));

		ids.add(start("photos"));
		assertThat(runIds("photos")).containsExactly(ids.get(2), ids.get(3), ids.get(4));
	}

	@Test
	void anOlderStartedAtIsDeletedEvenWhenItHasTheHigherId() throws Exception {
		clock.set(T0.plusSeconds(100));
		long late = start("analyzer");
		clock.set(T0.plusSeconds(1));
		long early1 = start("analyzer");
		clock.set(T0.plusSeconds(2));
		long early2 = start("analyzer");
		clock.set(T0.plusSeconds(3));
		long early3 = start("analyzer");

		// 보관 대상은 started_at 최신 3건(late, early3, early2)이다. 방금 시작한 early3까지 센 뒤 가장 오래된 early1이 지워진다.
		assertThat(runIds("analyzer")).containsExactly(late, early2, early3);
		assertThat(early1).isGreaterThan(late);
	}

	// ---- 3.4 종료 ----

	@Test
	void finishWithAnalyzerDetailRecordsFinishTimeAndLeavesItemsChangedNull() throws Exception {
		long id = start("analyzer");
		clock.set(T0.plusSeconds(90));

		JsonNode run = finish(id, "{\"outcome\":\"success\",\"detail\":" + ANALYZER_DETAIL + "}", 200);

		assertThat(run.propertyNames()).containsExactly("id", "worker", "startedAt", "finishedAt", "outcome",
				"errorKind", "errorMessage", "detail", "itemsChanged");
		assertThat(run.get("id").asLong()).isEqualTo(id);
		assertThat(run.get("worker").asString()).isEqualTo("analyzer");
		assertThat(run.get("startedAt").asString()).isEqualTo("2026-10-08T00:00:00.000Z");
		assertThat(run.get("finishedAt").asString()).isEqualTo("2026-10-08T00:01:30.000Z");
		assertThat(run.get("outcome").asString()).isEqualTo("success");
		assertThat(run.get("errorKind").isNull()).isTrue();
		assertThat(run.get("errorMessage").isNull()).isTrue();
		assertThat(run.get("itemsChanged").isNull()).isTrue();
		assertThat(run.get("detail").get("newCount").asInt()).isEqualTo(2);
		assertThat(run.get("detail").get("reanalysisCount").asInt()).isEqualTo(1);
		assertThat(run.get("detail").get("succeeded").asInt()).isEqualTo(3);
		assertThat(run.get("detail").get("failed").asInt()).isZero();
	}

	@Test
	void finishWithCollectorDetailSetsItemsChangedFromChanged() throws Exception {
		long id = start("collector");

		JsonNode run = finish(id, "{\"outcome\":\"blocked\",\"errorKind\":\"RobotDetectedError\","
				+ "\"errorMessage\":\"차단됨\",\"detail\":" + COLLECTOR_DETAIL + "}", 200);

		assertThat(run.get("outcome").asString()).isEqualTo("blocked");
		assertThat(run.get("errorKind").asString()).isEqualTo("RobotDetectedError");
		assertThat(run.get("errorMessage").asString()).isEqualTo("차단됨");
		assertThat(run.get("itemsChanged").asInt()).isEqualTo(5);
		assertThat(run.get("detail").get("targetCourts").get(0).asString()).isEqualTo("서울중앙지방법원");
		assertThat(jdbc.queryForObject("SELECT items_changed FROM worker_runs WHERE id = ?", Integer.class, id))
				.isEqualTo(5);
		JsonNode summary = perform(get("/api/worker-runs/summary"), 200);
		assertThat(summary.get("itemsChanged").asInt()).isEqualTo(5);
	}

	@Test
	void finishWithoutDetailStoresNullAndIsIdempotentInShape() throws Exception {
		long id = start("analyzer");

		JsonNode run = finish(id, "{\"outcome\":\"failed\",\"errorKind\":null,\"detail\":null}", 200);

		assertThat(run.get("detail").isNull()).isTrue();
		assertThat(run.get("itemsChanged").isNull()).isTrue();
		assertThat(jdbc.queryForObject("SELECT detail IS NULL FROM worker_runs WHERE id = ?", Boolean.class, id)).isTrue();
	}

	@Test
	void unknownKeysInTheBodyAndInDetailAreDroppedAndIntegralFloatsBecomeIntegers() throws Exception {
		long id = start("analyzer");

		JsonNode run = finish(id, "{\"outcome\":\"success\",\"junk\":1,\"detail\":{\"newCount\":3.0,"
				+ "\"reanalysisCount\":0,\"succeeded\":2.5,\"failed\":0,\"extra\":\"x\"}}", 200);

		assertThat(run.has("junk")).isFalse();
		JsonNode detail = run.get("detail");
		assertThat(detail.propertyNames()).containsExactlyInAnyOrder("newCount", "reanalysisCount", "succeeded",
				"failed");
		// 3.0은 3으로 쓰이고(JS 숫자), 2.5는 그대로다.
		assertThat(mvc.perform(get("/api/worker-runs")).andReturn().getResponse().getContentAsString())
				.contains("\"newCount\":3,").contains("\"succeeded\":2.5");
		assertThat(jdbc.queryForObject("SELECT detail FROM worker_runs WHERE id = ?", String.class, id))
				.doesNotContain("extra").doesNotContain("3.0");
	}

	@Test
	void whenBothShapesMatchTheCollectorShapeWins() throws Exception {
		long id = start("collector");

		JsonNode run = finish(id, "{\"outcome\":\"success\",\"detail\":{\"targetCourts\":[],\"pagesRequested\":1,"
				+ "\"itemsFetched\":1,\"inserted\":1,\"updated\":1,\"changed\":2,\"newCount\":9,"
				+ "\"reanalysisCount\":9,\"succeeded\":9,\"failed\":9}}", 200);

		assertThat(run.get("detail").has("newCount")).isFalse();
		assertThat(run.get("itemsChanged").asInt()).isEqualTo(2);
	}

	@Test
	void unknownAndNonNumericIdsAreNotFound() throws Exception {
		long id = start("analyzer");
		String body = "{\"outcome\":\"success\"}";

		JsonNode missing = finish(id + 100, body, 404);
		assertThat(missing.get("error").asString()).isEqualTo("회차를 찾을 수 없습니다: id=" + (id + 100));

		JsonNode text = perform(patch("/api/worker-runs/abc").content(body), 404);
		assertThat(text.get("error").asString()).isEqualTo("회차를 찾을 수 없습니다: id=abc");

		// 정적 경로 이름도 {id}로 잡히면 숫자가 아니므로 같은 404다.
		perform(patch("/api/worker-runs/summary").content(body), 404);
		JsonNode huge = perform(patch("/api/worker-runs/99999999999999999999999").content(body), 404);
		assertThat(huge.get("error").asString()).isEqualTo("회차를 찾을 수 없습니다: id=1e+23");
		assertThat(jdbc.queryForObject("SELECT outcome FROM worker_runs WHERE id = ?", String.class, id))
				.isEqualTo("running");
	}

	@Test
	void invalidBodiesAreRejectedAndLeaveTheRunUntouchedAndAreCheckedBeforeExistence() throws Exception {
		long id = start("analyzer");
		List<String> bad = List.of("{}", "{\"outcome\":\"running\"}", "{\"outcome\":\"skipped\"}",
				"{\"outcome\":\"success\",\"errorKind\":\"\"}", "{\"outcome\":\"success\",\"errorMessage\":5}",
				"{\"outcome\":\"success\",\"detail\":{}}", "{\"outcome\":\"success\",\"detail\":5}",
				"{\"outcome\":\"success\",\"detail\":{\"newCount\":1}}",
				"{\"outcome\":\"success\",\"detail\":{\"newCount\":\"1\",\"reanalysisCount\":0,\"succeeded\":0,\"failed\":0}}",
				// 사진 회차 형식은 PATCH도 받지 않는다.
				"{\"outcome\":\"success\",\"detail\":{\"attempted\":1,\"collected\":1,\"empty\":0,\"failed\":0,\"requestsMade\":2}}",
				"[]", "\"success\"");
		for (String body : bad) {
			JsonNode error = finish(id, body, 400);
			assertThat(error.get("error").asString()).as(body).isEqualTo("잘못된 회차 종료 본문입니다");
			assertThat(error.get("details")).as(body).isNotEmpty();
			// 존재하지 않는 id여도 본문이 틀리면 400이다(원본과 같은 순서).
			assertThat(finish(id + 100, body, 400).get("error").asString()).isEqualTo("잘못된 회차 종료 본문입니다");
		}
		assertThat(jdbc.queryForObject("SELECT outcome FROM worker_runs WHERE id = ?", String.class, id))
				.isEqualTo("running");

		JsonNode detail = finish(id, "{\"outcome\":\"success\",\"detail\":{\"newCount\":1}}", 400);
		assertThat(detail.get("details").get(0).get("field").asString()).isEqualTo("detail");
		JsonNode kind = finish(id, "{\"outcome\":\"success\",\"errorKind\":\"\"}", 400);
		assertThat(kind.get("details").get(0).get("field").asString()).isEqualTo("errorKind");
		JsonNode garbage = finish(id, "not json", 400);
		assertThat(garbage.get("error").asString()).isEqualTo("JSON 본문을 해석할 수 없습니다");
		assertThat(garbage.has("details")).isFalse();
	}

	// ---- 3.5 목록과 집계 ----

	@Test
	void listIsEmptyWithoutRuns() throws Exception {
		JsonNode list = perform(get("/api/worker-runs"), 200);

		assertThat(list.propertyNames()).containsExactly("runs", "total", "page", "pageSize");
		assertThat(list.get("runs")).isEmpty();
		assertThat(list.get("total").asInt()).isZero();
		assertThat(list.get("pageSize").asInt()).isEqualTo(20);
	}

	@Test
	void listIsNewestFirstWithIdDescendingTieBreakAndFiltersAndPaging() throws Exception {
		long a = start("collector");
		clock.set(T0.plusSeconds(10));
		long b = start("analyzer");
		finish(b, "{\"outcome\":\"success\",\"detail\":" + ANALYZER_DETAIL + "}", 200);
		clock.set(T0.plusSeconds(20));
		long c = start("analyzer");
		finish(c, "{\"outcome\":\"failed\",\"errorKind\":\"Boom\"}", 200);
		long d = start("analyzer"); // c와 같은 시작 시각: id 내림차순으로 d가 먼저다.

		assertThat(ids(perform(get("/api/worker-runs"), 200))).containsExactly(d, c, b, a);
		assertThat(ids(perform(get("/api/worker-runs?worker=analyzer&outcome=success"), 200))).containsExactly(b);
		assertThat(ids(perform(get("/api/worker-runs?outcome=running"), 200))).containsExactly(d, a);
		JsonNode page2 = perform(get("/api/worker-runs?pageSize=3&page=2"), 200);
		assertThat(ids(page2)).containsExactly(a);
		assertThat(page2.get("total").asInt()).isEqualTo(4);
		assertThat(page2.get("page").asInt()).isEqualTo(2);
		assertThat(page2.get("pageSize").asInt()).isEqualTo(3);
		assertThat(ids(perform(get("/api/worker-runs?page=9"), 200))).isEmpty();
		assertThat(ids(perform(get("/api/worker-runs?page=99999999999999"), 200))).isEmpty();
	}

	@Test
	void listRejectsBadParametersWithTheirFieldNames() throws Exception {
		JsonNode error = perform(get("/api/worker-runs?worker=nope&page=0&pageSize=1000"), 400);

		assertThat(error.get("error").asString()).isEqualTo("잘못된 요청 파라미터입니다");
		List<String> fields = new ArrayList<>();
		error.get("details").forEach(n -> fields.add(n.get("field").asString()));
		assertThat(fields).containsExactly("worker", "page", "pageSize");
		perform(get("/api/worker-runs?worker="), 400);
	}

	private static List<Long> ids(JsonNode list) {
		List<Long> ids = new ArrayList<>();
		list.get("runs").forEach(n -> ids.add(n.get("id").asLong()));
		return ids;
	}

}
