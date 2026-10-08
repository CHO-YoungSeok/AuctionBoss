package com.auctionboss.contract;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.request;

import java.io.IOException;
import java.io.InputStream;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.security.MessageDigest;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Stream;

import com.auctionboss.analysis.AnalysisSettings;
import com.auctionboss.common.seed.SeedLoader;
import com.auctionboss.support.FixedClockConfig;
import com.auctionboss.support.MutableClock;
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
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.util.ReflectionTestUtils;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.web.util.UriUtils;
import com.auctionboss.worker.WorkerSettings;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/**
 * 6.1: 쓰기 API 시나리오 골든({@code contracts/scenarios/*.json}, {@code scripts/seed/generate-scenarios.ts})을 단계 순서대로
 * 재생해 Next 응답과 비교한다 (design.md D10).
 *
 * <ul>
 * <li>시나리오마다 쓰기 대상 테이블을 비우고 시드를 다시 적재한 뒤 AUTO_INCREMENT를 재설정한다(id 정렬).</li>
 * <li>단계 i의 서버 시각은 {@code clock.start + i * stepMs}로 {@link MutableClock}을 맞춘다.</li>
 * <li>골든의 {@code config}는 설정 파일 사본으로 만들어 설정 빈이 읽게 한다(원본이 AUCTIONBOSS_CONFIG를 쓰는 것과 같다).</li>
 * <li>2xx는 {@link ContractTest#diff} 엄격 비교, 400은 {@code error}와 {@code details[].field}, 404는 {@code error},
 * 사진 200은 Content-Type·Cache-Control·SHA-256, 텍스트는 상태와 본문.</li>
 * </ul>
 */
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles({ "test", "seed" })
@Import({ MySqlTestContainer.class, FixedClockConfig.class })
class ScenarioContractTest {

	private static final JsonMapper JSON = JsonMapper.builder().build();

	private static final Pattern VARIABLE = Pattern.compile("\\{(\\w+)}");

	private static final Pattern ISO_MS = Pattern.compile("^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$");

	private static final String ISO_MS_MARKER = "<iso-ms>";

	/** 사진 디렉터리는 {@code BASE/photos}. {@code ../outside.png}는 {@code BASE/outside.png}에 놓인다. */
	private static Path base;

	@DynamicPropertySource
	static void photoDirectory(DynamicPropertyRegistry registry) throws IOException {
		if (base == null) {
			base = Files.createTempDirectory("auctionboss-scenario-");
		}
		registry.add("auctionboss.photos.dir", () -> base.resolve("photos").toString());
	}

	@Autowired
	MockMvc mvc;
	@Autowired
	JdbcTemplate jdbc;
	@Autowired
	SeedLoader seedLoader;
	@Autowired
	MutableClock clock;
	@Autowired
	WorkerSettings workerSettings;
	@Autowired
	AnalysisSettings analysisSettings;

	@TestFactory
	Stream<DynamicTest> 시나리오_골든과_같다() throws IOException {
		Resource[] files = new PathMatchingResourcePatternResolver().getResources("classpath:contracts/scenarios/*.json");
		assertThat(files).as("시나리오 파일").hasSize(7);
		int steps = 0;
		for (Resource file : files) {
			try (InputStream in = file.getInputStream()) {
				steps += JSON.readTree(in).get("steps").size();
			}
		}
		assertThat(steps).as("시나리오 단계 수").isEqualTo(115);
		return Arrays.stream(files).sorted(Comparator.comparing(Resource::getFilename)).map(file -> {
			String name = file.getFilename().replace(".json", "");
			return DynamicTest.dynamicTest(name, () -> play(name, file));
		});
	}

	@AfterEach
	void clean() throws IOException {
		clearAll();
		restoreConfig();
	}

	private void clearAll() throws IOException {
		jdbc.update("DELETE FROM items");
		jdbc.update("DELETE FROM worker_runs");
		jdbc.update("DELETE FROM collector_state");
		jdbc.update("DELETE FROM feed_reads");
		deleteTree(base.resolve("photos"));
		Files.deleteIfExists(base.resolve("outside.png"));
	}

	private void restoreConfig() {
		ReflectionTestUtils.setField(workerSettings, "configPath", "");
		ReflectionTestUtils.setField(analysisSettings, "configPath", "");
	}

	private static void deleteTree(Path dir) throws IOException {
		if (!Files.exists(dir)) {
			return;
		}
		try (Stream<Path> walk = Files.walk(dir)) {
			for (Path p : walk.sorted(Comparator.reverseOrder()).toList()) {
				Files.delete(p);
			}
		}
	}

	private void play(String name, Resource file) throws Exception {
		JsonNode scenario;
		try (InputStream in = file.getInputStream()) {
			scenario = JSON.readTree(in);
		}
		clearAll();
		assertThat(seedLoader.load()).isTrue();
		jdbc.execute("ALTER TABLE analyses AUTO_INCREMENT = 1");
		jdbc.execute("ALTER TABLE worker_runs AUTO_INCREMENT = 1");
		applyConfig(name, scenario.get("config"));
		preparePhotos(scenario.get("photos"));

		Instant start = Instant.parse(scenario.get("clock").get("start").asString());
		long stepMs = scenario.get("clock").get("stepMs").asLong();
		Map<String, String> variables = new HashMap<>();
		JsonNode steps = scenario.get("steps");
		for (int i = 0; i < steps.size(); i++) {
			JsonNode step = steps.get(i);
			clock.set(start.plusMillis(i * stepMs));
			String label = name + " 단계 " + i + " " + step.get("request").get("method").asString() + " "
					+ step.get("request").get("path").asString();
			try {
				playStep(step, variables);
			}
			catch (AssertionError e) {
				throw new AssertionError(label + "\n" + e.getMessage(), e);
			}
		}
	}

	private void applyConfig(String name, JsonNode config) throws IOException {
		Path real = Path.of("../config/collector.json");
		var merged = (tools.jackson.databind.node.ObjectNode) JSON.readTree(Files.readString(real));
		if (config.has("maxRunsPerWorker")) {
			((tools.jackson.databind.node.ObjectNode) merged.get("observability")).put("maxRunsPerWorker",
					config.get("maxRunsPerWorker").asInt());
		}
		if (config.has("reanalysisCooldownHours")) {
			((tools.jackson.databind.node.ObjectNode) merged.get("analysis")).put("reanalysisCooldownHours",
					config.get("reanalysisCooldownHours").asInt());
		}
		Path copy = Files.createTempFile(base, name + "-collector-", ".json");
		Files.writeString(copy, JSON.writeValueAsString(merged));
		ReflectionTestUtils.setField(workerSettings, "configPath", copy.toString());
		ReflectionTestUtils.setField(analysisSettings, "configPath", copy.toString());
	}

	private void preparePhotos(JsonNode photos) throws IOException {
		if (photos == null) {
			return;
		}
		Path fixtures = Path.of("src/test/resources/contracts/photos");
		for (JsonNode p : photos) {
			jdbc.update("INSERT INTO item_photos (item_id, seq, file_path, file_size, mime_type, collected_at) "
					+ "VALUES (?, ?, ?, ?, ?, ?)", p.get("itemId").asLong(), p.get("seq").asInt(),
					p.get("filePath").asString(), p.get("fileSize").asLong(), p.get("mimeType").asString(),
					p.get("collectedAt").asString().replace('T', ' ').replace("Z", ""));
			if (!p.get("fixture").isNull()) {
				Path dest = base.resolve("photos").resolve(p.get("filePath").asString()).normalize();
				Files.createDirectories(dest.getParent());
				Files.copy(fixtures.resolve(p.get("fixture").asString()), dest, StandardCopyOption.REPLACE_EXISTING);
			}
		}
	}

	private void playStep(JsonNode step, Map<String, String> variables) throws Exception {
		JsonNode req = step.get("request");
		String path = substitute(req.get("path").asString(), variables);
		String query = req.get("query").asString();
		var builder = request(org.springframework.http.HttpMethod.valueOf(req.get("method").asString()),
				URI.create(query.isEmpty() ? path : path + "?" + query));
		if (req.has("rawBody")) {
			builder.content(req.get("rawBody").asString().getBytes(StandardCharsets.UTF_8));
		}
		else if (req.has("body")) {
			builder.content(JSON.writeValueAsString(req.get("body")).getBytes(StandardCharsets.UTF_8));
		}
		var response = mvc.perform(builder).andReturn().getResponse();

		int expectedStatus = step.get("status").asInt();
		assertThat(response.getStatus()).as("status").isEqualTo(expectedStatus);

		if (step.has("photo")) {
			JsonNode photo = step.get("photo");
			assertThat(response.getContentType()).as("Content-Type").isEqualTo(photo.get("contentType").asString());
			assertThat(response.getHeader("Cache-Control")).as("Cache-Control")
				.isEqualTo(photo.get("cacheControl").asString());
			String sha = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(response.getContentAsByteArray()));
			assertThat(sha).as("본문 SHA-256").isEqualTo(photo.get("sha256").asString());
		}
		else if (step.has("text")) {
			assertThat(response.getContentAsString(StandardCharsets.UTF_8)).as("텍스트 본문")
				.isEqualTo(step.get("text").asString());
		}
		else {
			JsonNode actual = JSON.readTree(response.getContentAsString(StandardCharsets.UTF_8));
			JsonNode expected = step.get("body");
			if (expectedStatus == 400) {
				assertThat(actual.get("error")).as("error").isEqualTo(expected.get("error"));
				assertThat(fields(actual)).as("details[].field").isEqualTo(fields(expected));
			}
			else if (expectedStatus == 404) {
				assertThat(actual.get("error")).as("error").isEqualTo(expected.get("error"));
			}
			else {
				assertThat(diff("$", expected, actual)).as("골든과의 차이").isNull();
			}
			if (step.has("capture")) {
				for (var entry : step.get("capture").properties()) {
					variables.put(entry.getKey(), pick(actual, entry.getValue().asString()));
				}
			}
		}
	}

	private static String pick(JsonNode body, String jsonPath) {
		assertThat(jsonPath).startsWith("$.");
		JsonNode cur = body;
		for (String key : jsonPath.substring(2).split("\\.")) {
			cur = cur.path(key);
		}
		assertThat(cur.isMissingNode() || cur.isNull()).as("capture " + jsonPath).isFalse();
		return cur.asString();
	}

	private static String substitute(String text, Map<String, String> variables) {
		Matcher m = VARIABLE.matcher(text);
		StringBuilder out = new StringBuilder();
		while (m.find()) {
			String value = variables.get(m.group(1));
			assertThat(value).as("변수 " + m.group(1)).isNotNull();
			m.appendReplacement(out, Matcher.quoteReplacement(UriUtils.encodePathSegment(value, StandardCharsets.UTF_8)));
		}
		m.appendTail(out);
		return out.toString();
	}

	private static List<String> fields(JsonNode body) {
		List<String> out = new ArrayList<>();
		for (JsonNode detail : body.path("details")) {
			out.add(detail.get("field").asString());
		}
		return out;
	}

	/** {@code "<iso-ms>"} 표식 위치는 형식만 비교한다(현재 골든에는 없다). 나머지는 {@link ContractTest#diff}. */
	private static String diff(String path, JsonNode expected, JsonNode actual) {
		if (expected.isString() && ISO_MS_MARKER.equals(expected.asString())) {
			return actual.isString() && ISO_MS.matcher(actual.asString()).matches() ? null
					: path + ": 시각 형식이 아님 actual=" + actual;
		}
		if (expected.isObject() && actual.isObject()) {
			for (String key : new java.util.TreeSet<>(union(expected, actual))) {
				if (expected.has(key) != actual.has(key)) {
					return path + "." + key + ": 키가 " + (expected.has(key) ? "응답에 없음" : "골든에 없음");
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
		return ContractTest.diff(path, expected, actual);
	}

	private static java.util.Set<String> union(JsonNode a, JsonNode b) {
		java.util.Set<String> keys = new java.util.HashSet<>(a.propertyNames());
		keys.addAll(b.propertyNames());
		return keys;
	}

}
