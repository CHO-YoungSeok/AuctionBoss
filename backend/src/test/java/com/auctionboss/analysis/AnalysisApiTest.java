package com.auctionboss.analysis;

import static com.auctionboss.support.TestData.item;
import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.time.Instant;
import java.time.LocalDateTime;

import com.auctionboss.item.Item;
import com.auctionboss.item.ItemRepository;
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

/** 2.3, 2.4: POST /api/analyses 계약과 저장 직후 읽기 API 반영. */
@AutoConfigureMockMvc
@Import(FixedClockConfig.class)
@TestPropertySource(properties = "auctionboss.analysis.reanalysis-cooldown-hours=24")
class AnalysisApiTest extends AbstractMySqlTest {

	private static final JsonMapper JSON = JsonMapper.builder().build();

	@Autowired
	MockMvc mvc;
	@Autowired
	ItemRepository items;
	@Autowired
	AnalysisRepository analyses;
	@Autowired
	MutableClock clock;

	@BeforeEach
	void resetClock() {
		clock.set(FixedClockConfig.DEFAULT_NOW);
	}

	private MockHttpServletRequestBuilder postJson(String body) {
		return post("/api/analyses").contentType(MediaType.APPLICATION_JSON).content(body);
	}

	private JsonNode perform(MockHttpServletRequestBuilder request, int expectedStatus) throws Exception {
		var result = mvc.perform(request).andExpect(status().is(expectedStatus)).andReturn();
		return JSON.readTree(result.getResponse().getContentAsString());
	}

	private Item saveItem() {
		return items.save(item("2026타경1", "1").build());
	}

	@Test
	void savesAnAnalysisWithModelAndRespondsWithServerTime() throws Exception {
		Item it = saveItem();
		// 마이크로초가 있는 시각: 응답 값과 저장 값이 같으려면 밀리초로 잘려야 한다.
		clock.set(Instant.parse("2026-10-08T01:02:03.123456Z"));

		JsonNode saved = perform(postJson(
				"{\"itemId\":" + it.getId() + ",\"body\":\"분석 본문\",\"promptVersion\":\"v1\",\"model\":\"m-1\"}"), 201);

		assertThat(saved.propertyNames()).containsExactly("id", "itemId", "body", "model", "promptVersion", "analyzedAt");
		assertThat(saved.get("itemId").asLong()).isEqualTo(it.getId());
		assertThat(saved.get("body").asString()).isEqualTo("분석 본문");
		assertThat(saved.get("model").asString()).isEqualTo("m-1");
		assertThat(saved.get("promptVersion").asString()).isEqualTo("v1");
		assertThat(saved.get("analyzedAt").asString()).isEqualTo("2026-10-08T01:02:03.123Z");
		LocalDateTime stored = jdbc.queryForObject("SELECT analyzed_at FROM analyses WHERE id = ?", LocalDateTime.class,
				saved.get("id").asLong());
		assertThat(stored).isEqualTo(LocalDateTime.parse("2026-10-08T01:02:03.123"));
	}

	/** V3: Next(SQLite)는 길이 제한 없이 받는 입력을 MySQL 컬럼 길이 때문에 500으로 거절하지 않는다. */
	@Test
	void acceptsLongPromptVersionLongModelAndMultiHundredKilobyteBody() throws Exception {
		Item it = saveItem();
		String promptVersion = "p".repeat(255);
		String model = "m".repeat(255);
		String body = "분석".repeat(150_000); // 300,000자, UTF-8로 약 900KB. TEXT(65,535바이트)에는 들어가지 않는다.

		JsonNode saved = perform(postJson(JSON.writeValueAsString(java.util.Map.of("itemId", it.getId(), "body", body,
				"promptVersion", promptVersion, "model", model))), 201);

		assertThat(saved.get("body").asString().equals(body)).as("응답 본문").isTrue();
		assertThat(saved.get("promptVersion").asString()).isEqualTo(promptVersion);
		assertThat(saved.get("model").asString()).isEqualTo(model);
		assertThat(body.equals(jdbc.queryForObject("SELECT body FROM analyses WHERE id = ?", String.class,
				saved.get("id").asLong()))).as("저장된 본문").isTrue();
		// 상세의 최신 분석으로도 그대로 읽힌다.
		JsonNode detail = perform(get("/api/items/" + it.getId()), 200);
		assertThat(detail.at("/analysis/body").asString().equals(body)).as("상세의 최신 분석 본문").isTrue();
	}

	@Test
	void omittedModelIsStoredAsNull() throws Exception {
		Item it = saveItem();

		JsonNode saved = perform(postJson("{\"itemId\":" + it.getId() + ",\"body\":\"b\",\"promptVersion\":\"v1\"}"), 201);

		assertThat(saved.get("model").isNull()).isTrue();
		assertThat(jdbc.queryForObject("SELECT model FROM analyses WHERE id = ?", String.class,
				saved.get("id").asLong())).isNull();
	}

	@Test
	void unknownItemIsNotFoundAndNothingIsStored() throws Exception {
		Item it = saveItem();
		long missing = it.getId() + 1000;

		JsonNode error = perform(postJson("{\"itemId\":" + missing + ",\"body\":\"b\",\"promptVersion\":\"v1\"}"), 404);

		assertThat(error.get("error").asString()).isEqualTo("물건을 찾을 수 없습니다: id=" + missing);
		assertThat(error.has("details")).isFalse();
		assertThat(analyses.count()).isZero();
	}

	@Test
	void unknownItemIsRejectedBeforeAnyInsertIsAttempted() throws Exception {
		Item it = saveItem();
		long first = perform(postJson("{\"itemId\":" + it.getId() + ",\"body\":\"b\",\"promptVersion\":\"v1\"}"), 201)
				.get("id").asLong();

		perform(postJson("{\"itemId\":" + (it.getId() + 1000) + ",\"body\":\"b\",\"promptVersion\":\"v1\"}"), 404);
		long second = perform(postJson("{\"itemId\":" + it.getId() + ",\"body\":\"b\",\"promptVersion\":\"v1\"}"), 201)
				.get("id").asLong();

		// 외래 키 위반으로 끝난 INSERT는 AUTO_INCREMENT 값을 소모한다. 존재 확인이 먼저 거절하면 id가 건너뛰지 않는다.
		assertThat(second).isEqualTo(first + 1);
	}

	@Test
	void stringItemIdIsRejectedWithFieldDetailsInSchemaOrder() throws Exception {
		JsonNode error = perform(postJson("{\"itemId\":\"1\",\"body\":\"\",\"promptVersion\":\"v1\"}"), 400);

		assertThat(error.get("error").asString()).isEqualTo("잘못된 분석 결과 본문입니다");
		assertThat(error.get("details")).hasSize(2);
		assertThat(error.get("details").get(0).get("field").asString()).isEqualTo("itemId");
		assertThat(error.get("details").get(1).get("field").asString()).isEqualTo("body");
	}

	@Test
	void emptyAndUnparseableBodiesAreBadRequestsWithoutDetails() throws Exception {
		JsonNode empty = perform(post("/api/analyses").contentType(MediaType.APPLICATION_JSON), 400);
		JsonNode garbage = perform(postJson("이건 JSON이 아니다"), 400);

		for (JsonNode error : new JsonNode[] { empty, garbage }) {
			assertThat(error.get("error").asString()).isEqualTo("JSON 본문을 해석할 수 없습니다");
			assertThat(error.has("details")).isFalse();
		}
	}

	@Test
	void arrayBodyIsReportedAtRoot() throws Exception {
		JsonNode error = perform(postJson("[1,2]"), 400);

		assertThat(error.get("error").asString()).isEqualTo("잘못된 분석 결과 본문입니다");
		assertThat(error.get("details")).hasSize(1);
		assertThat(error.get("details").get(0).get("field").asString()).isEqualTo("(root)");
	}

	@Test
	void requestsWithoutOrWithOtherContentTypesStillSucceed() throws Exception {
		Item it = saveItem();
		String body = "{\"itemId\":" + it.getId() + ",\"body\":\"b\",\"promptVersion\":\"v1\"}";

		perform(post("/api/analyses").content(body), 201);
		perform(post("/api/analyses").contentType(MediaType.TEXT_PLAIN).content(body), 201);

		assertThat(analyses.count()).isEqualTo(2);
	}

	@Test
	void unknownKeysAreIgnoredAndIntegralFloatItemIdIsAccepted() throws Exception {
		Item it = saveItem();

		JsonNode saved = perform(postJson("{\"itemId\":" + it.getId() + ".0,\"body\":\"b\",\"promptVersion\":\"v1\","
				+ "\"extra\":{\"a\":1},\"analyzedAt\":\"2000-01-01T00:00:00.000Z\"}"), 201);

		assertThat(saved.has("extra")).isFalse();
		// 분석 시각은 본문이 아니라 서버 시각이다.
		assertThat(saved.get("analyzedAt").asString()).isEqualTo("2026-10-08T12:00:00.000Z");
	}

	@Test
	void savedAnalysisIsTheLatestInDetailAndLeavesTheReanalysisCandidateList() throws Exception {
		Item it = saveItem();
		// 쿨다운(24시간)보다 오래된 v1 분석이 있다.
		analyses.save(new Analysis(it, "옛 분석", "m", "v1", Instant.parse("2026-09-01T00:00:00Z")));
		mvc.perform(get("/api/items?needsAnalysis=true&promptVersion=v2")).andExpect(status().isOk())
				.andExpect(jsonPath("$.total").value(1));

		JsonNode saved = perform(
				postJson("{\"itemId\":" + it.getId() + ",\"body\":\"새 분석\",\"promptVersion\":\"v2\",\"model\":\"m\"}"), 201);

		mvc.perform(get("/api/items/" + it.getId())).andExpect(status().isOk())
				.andExpect(jsonPath("$.analysis.id").value(saved.get("id").asLong()))
				.andExpect(jsonPath("$.analysis.body").value("새 분석"))
				.andExpect(jsonPath("$.analysis.promptVersion").value("v2"))
				.andExpect(jsonPath("$.analysis.analyzedAt").value("2026-10-08T12:00:00.000Z"));
		// 방금 v2로 분석했으므로 후보가 아니다. 쿨다운이 지나면(25시간 뒤) 다시 v3 후보가 된다.
		mvc.perform(get("/api/items?needsAnalysis=true&promptVersion=v2")).andExpect(jsonPath("$.total").value(0));
		clock.set(Instant.parse("2026-10-09T13:00:00Z"));
		mvc.perform(get("/api/items?needsAnalysis=true&promptVersion=v3")).andExpect(jsonPath("$.total").value(1));
		mvc.perform(get("/api/items?analyzed=true")).andExpect(jsonPath("$.total").value(1));
	}

}
