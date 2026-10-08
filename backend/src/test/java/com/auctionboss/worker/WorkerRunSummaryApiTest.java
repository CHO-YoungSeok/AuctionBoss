package com.auctionboss.worker;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.patch;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;

import com.auctionboss.support.AbstractMySqlTest;
import com.auctionboss.support.FixedClockConfig;
import com.auctionboss.support.MutableClock;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.context.annotation.Import;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/** 3.5: 집계. 보관 상한(기본 설정)에 걸리지 않도록 목록 테스트와 따로 둔다. */
@AutoConfigureMockMvc
@Import(FixedClockConfig.class)
class WorkerRunSummaryApiTest extends AbstractMySqlTest {

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

	private void at(String iso) {
		clock.set(Instant.parse(iso));
	}

	@Test
	void summaryOfNoRunsHasNullSuccessRate() throws Exception {
		JsonNode summary = perform(get("/api/worker-runs/summary"), 200);

		assertThat(summary.propertyNames()).containsExactly("totalRuns", "successCount", "failedCount", "blockedCount",
				"skippedCount", "runningCount", "successRate", "itemsChanged");
		assertThat(summary.get("totalRuns").asInt()).isZero();
		assertThat(summary.get("successRate").isNull()).isTrue();
		assertThat(summary.get("itemsChanged").asInt()).isZero();
	}

	@Test
	void summaryCountsOutcomesFiltersByWorkerAndSinceAndWritesIntegralRatesAsIntegers() throws Exception {
		at("2026-09-30T00:00:00Z");
		long oldRun = start("collector");
		finish(oldRun, "{\"outcome\":\"failed\"}", 200);
		at("2026-10-02T00:00:00Z");
		long ok1 = start("collector");
		finish(ok1, "{\"outcome\":\"success\",\"detail\":" + COLLECTOR_DETAIL + "}", 200);
		at("2026-10-03T00:00:00Z");
		long ok2 = start("collector");
		finish(ok2, "{\"outcome\":\"success\",\"detail\":" + COLLECTOR_DETAIL.replace("\"changed\":5", "\"changed\":2")
				+ "}", 200);
		at("2026-10-04T00:00:00Z");
		long blocked = start("collector");
		finish(blocked, "{\"outcome\":\"blocked\"}", 200);
		start("collector"); // running
		at("2026-10-05T00:00:00Z");
		long analyzer = start("analyzer");
		finish(analyzer, "{\"outcome\":\"success\",\"detail\":" + ANALYZER_DETAIL + "}", 200);
		jdbc.update("INSERT INTO worker_runs (worker, started_at, finished_at, outcome, error_kind, created_at) "
				+ "VALUES ('analyzer', '2026-10-05 01:00:00.000', '2026-10-05 01:00:00.000', 'skipped', 'overlap', "
				+ "'2026-10-05 01:00:00.000')");

		JsonNode all = perform(get("/api/worker-runs/summary"), 200);
		assertThat(all.get("totalRuns").asInt()).isEqualTo(7);
		assertThat(all.get("successCount").asInt()).isEqualTo(3);
		assertThat(all.get("failedCount").asInt()).isEqualTo(1);
		assertThat(all.get("blockedCount").asInt()).isEqualTo(1);
		assertThat(all.get("skippedCount").asInt()).isEqualTo(1);
		assertThat(all.get("runningCount").asInt()).isEqualTo(1);
		assertThat(all.get("successRate").asDouble()).isEqualTo(3.0 / 5.0);
		assertThat(all.get("itemsChanged").asInt()).isEqualTo(7);

		JsonNode collectorOnly = perform(get("/api/worker-runs/summary?worker=collector"), 200);
		assertThat(collectorOnly.get("totalRuns").asInt()).isEqualTo(5);

		// since: 날짜만(그 날 UTC 0시 포함), Z 시각, 오프셋 시각이 같은 경계를 만든다.
		for (String since : List.of("2026-10-02", "2026-10-02T00:00:00.000Z", "2026-10-02T09:00:00+09:00")) {
			JsonNode recent = perform(get("/api/worker-runs/summary").param("worker", "collector").param("since", since), 200);
			assertThat(recent.get("totalRuns").asInt()).as(since).isEqualTo(4);
			assertThat(recent.get("failedCount").asInt()).as(since).isZero();
		}
		assertThat(perform(get("/api/worker-runs/summary?since=2026-10-02T00:00:00.001Z&worker=collector"), 200)
				.get("totalRuns").asInt()).isEqualTo(3);

		// 정수 성공률은 정수로 쓰인다(JS 직렬화).
		String onlySuccess = mvc.perform(get("/api/worker-runs/summary?worker=analyzer&since=2026-10-05")).andReturn()
				.getResponse().getContentAsString();
		assertThat(onlySuccess).contains("\"successRate\":1,");
	}

	@Test
	void summaryRejectsBadParameters() throws Exception {
		JsonNode error = perform(get("/api/worker-runs/summary?worker=nope&since=not-a-date"), 400);

		List<String> fields = new ArrayList<>();
		error.get("details").forEach(n -> fields.add(n.get("field").asString()));
		assertThat(fields).containsExactly("worker", "since");
	}

	@Test
	void summaryPathIsNotCapturedByTheIdMapping() throws Exception {
		// GET에는 {id} 매핑이 없고 summary만 있다. summary가 숫자 id처럼 처리되면 404나 405가 나온다.
		mvc.perform(get("/api/worker-runs/summary")).andExpect(status().isOk());
		mvc.perform(get("/api/worker-runs/1")).andExpect(status().is(405));
	}

}
