package com.auctionboss.contract;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;

import java.io.IOException;
import java.io.InputStream;
import java.math.BigDecimal;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.stream.Stream;

import com.auctionboss.common.seed.SeedLoader;
import com.auctionboss.support.MySqlTestContainer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.DynamicTest;
import org.junit.jupiter.api.TestFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.context.annotation.Import;
import org.springframework.core.io.Resource;
import org.springframework.core.io.support.PathMatchingResourcePatternResolver;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.TestPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/**
 * 6.2: 기존 Next.js API의 응답(골든, {@code src/test/resources/contracts/*.json})과 Spring 응답을 비교한다.
 * 골든은 {@code scripts/seed/generate-contracts.ts}가 시드와 같은 가림 데이터에서 만든다.
 *
 * <ul>
 * <li>200: JSON 의미 비교(키 집합, 값, 배열 순서). 키 순서는 비교하지 않는다. 숫자는 값과 정수/실수 여부까지 같아야 한다.</li>
 * <li>400: {@code error}와 {@code details[].field}만 비교한다(메시지 문구 제외).</li>
 * <li>404: status와 {@code error}.</li>
 * </ul>
 *
 * 공용 컨테이너를 쓰므로 팩토리 메서드에서 비우고 시드를 적재하고, 끝나면(AfterEach) 다시 비운다.
 */
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles({ "test", "seed" })
@Import(MySqlTestContainer.class)
@TestPropertySource(properties = "auctionboss.analysis.reanalysis-cooldown-hours=24")
class ContractTest {

	private static final JsonMapper JSON = JsonMapper.builder().build();

	@Autowired
	MockMvc mvc;
	@Autowired
	JdbcTemplate jdbc;
	@Autowired
	SeedLoader seedLoader;

	@TestFactory
	Stream<DynamicTest> 골든_응답과_같다() throws IOException {
		clearAll();
		assertThat(seedLoader.load()).isTrue();

		Resource[] files = new PathMatchingResourcePatternResolver().getResources("classpath:contracts/*.json");
		assertThat(files).as("골든 파일").hasSizeGreaterThanOrEqualTo(80);
		return Arrays.stream(files).sorted(Comparator.comparing(Resource::getFilename)).map(file -> {
			String name = file.getFilename().replace(".json", "");
			return DynamicTest.dynamicTest(name, () -> verify(file));
		});
	}

	@AfterEach
	void clean() {
		clearAll();
	}

	private void clearAll() {
		jdbc.update("DELETE FROM items");
		jdbc.update("DELETE FROM worker_runs");
		jdbc.update("DELETE FROM collector_state");
		jdbc.update("DELETE FROM feed_reads");
	}

	private void verify(Resource file) throws Exception {
		JsonNode golden;
		try (InputStream in = file.getInputStream()) {
			golden = JSON.readTree(in);
		}
		String path = golden.get("request").get("path").asString();
		String query = golden.get("request").get("query").asString();
		int expectedStatus = golden.get("status").asInt();

		var response = mvc.perform(get(URI.create(query.isEmpty() ? path : path + "?" + query))).andReturn().getResponse();
		assertThat(response.getStatus()).as("status").isEqualTo(expectedStatus);
		JsonNode actual = JSON.readTree(response.getContentAsString(StandardCharsets.UTF_8));
		JsonNode expected = golden.get("body");

		if (expectedStatus == 400) {
			assertThat(actual.get("error")).as("error").isEqualTo(expected.get("error"));
			assertThat(fields(actual)).as("details[].field").isEqualTo(fields(expected));
		}
		else if (expectedStatus == 404) {
			assertThat(actual.get("error")).as("error").isEqualTo(expected.get("error"));
		}
		else {
			String diff = diff("$", expected, actual);
			assertThat(diff).as("골든과의 차이").isNull();
		}
	}

	private static List<String> fields(JsonNode body) {
		List<String> out = new ArrayList<>();
		for (JsonNode detail : body.path("details")) {
			out.add(detail.get("field").asString());
		}
		return out;
	}

	/** 첫 번째 차이의 경로와 내용을 돌려준다. 같으면 null. 객체는 키 순서를 무시하고 배열은 순서까지 비교한다. */
	static String diff(String path, JsonNode expected, JsonNode actual) {
		if (expected == null || actual == null) {
			return path + ": expected=" + expected + " actual=" + actual;
		}
		if (expected.isObject() && actual.isObject()) {
			Set<String> keys = new HashSet<>(expected.propertyNames());
			keys.addAll(actual.propertyNames());
			for (String key : keys.stream().sorted().toList()) {
				boolean inExpected = expected.has(key);
				boolean inActual = actual.has(key);
				if (inExpected != inActual) {
					return path + "." + key + ": 키가 " + (inExpected ? "응답에 없음" : "골든에 없음");
				}
				String d = diff(path + "." + key, expected.get(key), actual.get(key));
				if (d != null) {
					return d;
				}
			}
			return null;
		}
		if (expected.isArray() && actual.isArray()) {
			if (expected.size() != actual.size()) {
				return path + ": 배열 길이 expected=" + expected.size() + " actual=" + actual.size();
			}
			for (int i = 0; i < expected.size(); i++) {
				String d = diff(path + "[" + i + "]", expected.get(i), actual.get(i));
				if (d != null) {
					return d;
				}
			}
			return null;
		}
		if (expected.isNumber() && actual.isNumber()) {
			boolean sameKind = expected.isIntegralNumber() == actual.isIntegralNumber();
			boolean sameValue = new BigDecimal(expected.asString()).compareTo(new BigDecimal(actual.asString())) == 0;
			return sameKind && sameValue ? null
					: path + ": 숫자 expected=" + expected.asString() + " actual=" + actual.asString();
		}
		if (expected.equals(actual)) {
			return null;
		}
		return path + ": expected=" + expected + " actual=" + actual;
	}

}
