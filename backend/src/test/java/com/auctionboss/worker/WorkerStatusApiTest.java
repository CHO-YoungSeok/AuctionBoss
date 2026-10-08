package com.auctionboss.worker;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;

import java.time.Instant;

import com.auctionboss.support.AbstractMySqlTest;
import com.auctionboss.support.FixedClockConfig;
import com.auctionboss.support.MutableClock;
import com.auctionboss.support.TestData;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.context.annotation.Import;
import org.springframework.test.context.TestPropertySource;
import org.springframework.test.util.ReflectionTestUtils;
import org.springframework.test.web.servlet.MockMvc;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/**
 * 3.7, 3.8: 워커 상태 판정({@code /api/worker-runs/status})과 로테이션 위치({@code /api/collector-state/rotation}).
 * 판정의 "지금"은 주입된 Clock이다. 기대 주기는 collector 10분, analyzer 10분, photos 30분(덮어쓰기), 배수는 3이다.
 */
@AutoConfigureMockMvc
@Import(FixedClockConfig.class)
@TestPropertySource(properties = { "auctionboss.worker.collector-interval-ms=600000",
		"auctionboss.worker.analyzer-interval-ms=600000", "auctionboss.worker.photos-interval-ms=1800000",
		"auctionboss.worker.stale-after-intervals=3" })
class WorkerStatusApiTest extends AbstractMySqlTest {

	private static final JsonMapper JSON = JsonMapper.builder().build();

	private static final Instant T0 = Instant.parse("2026-10-08T00:00:00Z");

	@Autowired
	MockMvc mvc;
	@Autowired
	MutableClock clock;
	@Autowired
	WorkerSettings settings;

	@BeforeEach
	void resetClock() {
		clock.set(T0);
	}

	@AfterEach
	void restoreOverrides() {
		ReflectionTestUtils.setField(settings, "collectorIntervalOverride", 600_000);
		ReflectionTestUtils.setField(settings, "staleAfterOverride", 3);
	}

	private static Instant min(int minutes) {
		return T0.plusSeconds(60L * minutes);
	}

	private JsonNode status(String query) throws Exception {
		var response = mvc.perform(get("/api/worker-runs/status" + query)).andReturn().getResponse();
		return JSON.readTree(response.getContentAsString(java.nio.charset.StandardCharsets.UTF_8));
	}

	private JsonNode status(String worker, int expectedStatus) throws Exception {
		var response = mvc.perform(get("/api/worker-runs/status?worker=" + worker)).andReturn().getResponse();
		assertThat(response.getStatus()).isEqualTo(expectedStatus);
		return JSON.readTree(response.getContentAsString(java.nio.charset.StandardCharsets.UTF_8));
	}

	private void run(String worker, int startMin, Integer endMin, String outcome) {
		TestData.insertRun(jdbc, worker, min(startMin), endMin == null ? null : min(endMin), outcome);
	}

	@Test
	void noRunsIsStaleWithNullLastSuccessAndLastRun() throws Exception {
		JsonNode body = status("collector", 200);

		assertThat(body.propertyNames()).containsExactly("state", "lastSuccessAt", "lastRun");
		assertThat(body.get("state").asString()).isEqualTo("stale");
		assertThat(body.get("lastSuccessAt").isNull()).isTrue();
		assertThat(body.get("lastRun").isNull()).isTrue();
	}

	@Test
	void recentSuccessIsOk() throws Exception {
		clock.set(min(10));
		run("collector", 1, 2, "success");

		JsonNode body = status("collector", 200);

		assertThat(body.get("state").asString()).isEqualTo("ok");
		assertThat(body.get("lastSuccessAt").asString()).isEqualTo("2026-10-08T00:02:00.000Z");
		assertThat(body.get("lastRun").get("outcome").asString()).isEqualTo("success");
		assertThat(body.get("lastRun").propertyNames()).containsExactly("id", "worker", "startedAt", "finishedAt",
				"outcome", "errorKind", "errorMessage", "detail", "itemsChanged");
	}

	@Test
	void blockedThenRunningIsBlockedAndLastRunIsTheRunningOne() throws Exception {
		clock.set(min(10));
		run("collector", 1, 2, "success");
		run("collector", 3, 4, "blocked");
		run("collector", 5, null, "running");

		JsonNode body = status("collector", 200);

		assertThat(body.get("state").asString()).isEqualTo("blocked");
		assertThat(body.get("lastRun").get("outcome").asString()).isEqualTo("running");
		assertThat(body.get("lastRun").get("finishedAt").isNull()).isTrue();
	}

	@Test
	void blockedThenOnlySkippedRunsStaysBlockedAndLastRunIsTheSkippedOne() throws Exception {
		clock.set(min(10));
		run("collector", 1, 2, "success");
		run("collector", 3, 4, "blocked");
		run("collector", 5, 5, "skipped");
		run("collector", 6, 6, "skipped");

		JsonNode body = status("collector", 200);

		assertThat(body.get("state").asString()).isEqualTo("blocked");
		assertThat(body.get("lastRun").get("outcome").asString()).isEqualTo("skipped");
		assertThat(body.get("lastRun").get("startedAt").asString()).isEqualTo("2026-10-08T00:06:00.000Z");
	}

	@Test
	void failedAfterSuccessIsFailed() throws Exception {
		clock.set(min(10));
		run("analyzer", 1, 2, "success");
		run("analyzer", 3, 4, "failed");

		assertThat(status("analyzer", 200).get("state").asString()).isEqualTo("failed");
	}

	@Test
	void successFollowedByFailureThenSuccessIsOk() throws Exception {
		clock.set(min(10));
		run("analyzer", 1, 2, "failed");
		run("analyzer", 3, 4, "success");

		assertThat(status("analyzer", 200).get("state").asString()).isEqualTo("ok");
	}

	@Test
	void staleAfterIntervalTimesMultiplierKeepsLastSuccessAt() throws Exception {
		run("collector", 0, 1, "success");
		run("collector", 2, 3, "failed");

		clock.set(min(1).plusSeconds(1800)); // 성공으로부터 정확히 30분: 아직 아니다(초과여야 stale)
		assertThat(status("collector", 200).get("state").asString()).isEqualTo("failed");

		clock.set(min(1).plusSeconds(1800).plusMillis(1));
		JsonNode body = status("collector", 200);
		assertThat(body.get("state").asString()).isEqualTo("stale");
		assertThat(body.get("lastSuccessAt").asString()).isEqualTo("2026-10-08T00:01:00.000Z");
		assertThat(body.get("lastRun").get("outcome").asString()).isEqualTo("failed");
	}

	@Test
	void withoutAnySuccessTheLastRunStartIsTheReference() throws Exception {
		run("collector", 0, null, "running"); // 성공 없이 남은 진행 중 회차

		clock.set(min(0).plusSeconds(1800));
		assertThat(status("collector", 200).get("state").asString()).isEqualTo("ok");

		clock.set(min(0).plusSeconds(1800).plusMillis(1));
		JsonNode body = status("collector", 200);
		assertThat(body.get("state").asString()).isEqualTo("stale");
		assertThat(body.get("lastSuccessAt").isNull()).isTrue();
		assertThat(body.get("lastRun").get("outcome").asString()).isEqualTo("running");
	}

	@Test
	void eachWorkerUsesItsOwnExpectedInterval() throws Exception {
		run("collector", 0, 1, "success");
		run("photos", 0, 1, "success");
		clock.set(min(1).plusSeconds(3600)); // 1시간 뒤: 수집 한계 30분 초과, 사진 한계 90분 이내

		assertThat(status("collector", 200).get("state").asString()).isEqualTo("stale");
		assertThat(status("photos", 200).get("state").asString()).isEqualTo("ok");
	}

	@Test
	void intervalAndMultiplierOverridesAreApplied() throws Exception {
		run("collector", 0, 1, "success");
		clock.set(min(1).plusSeconds(100));
		assertThat(status("collector", 200).get("state").asString()).isEqualTo("ok");

		ReflectionTestUtils.setField(settings, "collectorIntervalOverride", 30_000);
		ReflectionTestUtils.setField(settings, "staleAfterOverride", 2);
		assertThat(status("collector", 200).get("state").asString()).isEqualTo("stale");
	}

	@Test
	void missingEmptyOrUnknownWorkerIs400WithTheWorkerField() throws Exception {
		for (String query : new String[] { "", "?worker=", "?worker=foo", "?worker=COLLECTOR" }) {
			var response = mvc.perform(get("/api/worker-runs/status" + query)).andReturn().getResponse();

			assertThat(response.getStatus()).as(query).isEqualTo(400);
			JsonNode body = JSON.readTree(response.getContentAsString());
			assertThat(body.get("details")).hasSize(1);
			assertThat(body.get("details").get(0).get("field").asString()).isEqualTo("worker");
		}
	}

	@Test
	void statusPathIsNotCapturedByTheIdRoute() throws Exception {
		// PATCH /{id}와 겹치지 않는다: status는 GET 리터럴이다.
		assertThat(status("collector", 200).get("state").asString()).isEqualTo("stale");
	}

	@Test
	void rotationReturnsTheRecordedCourtCodeOrNull() throws Exception {
		var empty = mvc.perform(get("/api/collector-state/rotation")).andReturn().getResponse();
		assertThat(empty.getStatus()).isEqualTo(200);
		JsonNode none = JSON.readTree(empty.getContentAsString());
		assertThat(none.propertyNames()).containsExactly("nextCourtCode");
		assertThat(none.get("nextCourtCode").isNull()).isTrue();

		jdbc.update("INSERT INTO collector_state (`key`, value, updated_at) VALUES "
				+ "('collector.rotation.nextCourtCode', 'B000211', NOW(3)), ('backoff_until', '2026-10-09T00:00:00.000Z', NOW(3))");

		JsonNode body = JSON.readTree(
				mvc.perform(get("/api/collector-state/rotation")).andReturn().getResponse().getContentAsString());
		assertThat(body.propertyNames()).containsExactly("nextCourtCode");
		assertThat(body.get("nextCourtCode").asString()).isEqualTo("B000211");
	}

}
