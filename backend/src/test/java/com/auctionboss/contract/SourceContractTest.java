package com.auctionboss.contract;

import static org.assertj.core.api.Assertions.assertThat;

import com.auctionboss.collect.source.CollectScope;
import com.auctionboss.collect.source.CourtRef;
import com.auctionboss.collect.source.FetchActiveItemsResult;
import com.auctionboss.collect.source.FetchItemPhotosResult;
import com.auctionboss.collect.source.PhotoLookupRef;
import com.auctionboss.collect.source.RecordingSleeper;
import com.auctionboss.collect.source.ReplayServer;
import com.auctionboss.collect.source.SourceException;
import com.auctionboss.collect.source.courtauction.CourtAuctionAdapter;
import com.auctionboss.collect.source.courtauction.CourtAuctionOptions;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.HexFormat;
import java.util.List;
import java.util.Set;
import java.util.stream.Stream;

import org.junit.jupiter.api.DynamicTest;
import org.junit.jupiter.api.TestFactory;
import org.springframework.core.io.Resource;
import org.springframework.core.io.support.PathMatchingResourcePatternResolver;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;
import tools.jackson.databind.node.ArrayNode;
import tools.jackson.databind.node.ObjectNode;

/**
 * 2.5: 어댑터 골든({@code contracts/source/*.json}, {@code scripts/collector-golden/generate-source-goldens.ts})을 MockWebServer
 * 루프백으로 재생해 Java 어댑터가 TS 어댑터와 같은 결과·같은 요청·같은 대기를 내는지 비교한다 (design D5).
 *
 * <ul>
 * <li>결과: 물건은 {@link ContractTest#diff} 엄격 비교(키 집합, 값, 숫자의 정수 여부), 사진은 순번·base64 길이·SHA-256, 오류는
 * {@code kind}·{@code requestsMade}·메시지 첫 줄(형식 위반의 이슈 문구는 Java가 같은 문장을 만들 수 없어 첫 줄만 본다)</li>
 * <li>요청: 순서, 메서드, 경로, 본문(JSON 의미 비교), 헤더(이름 대소문자 무시, {@code host}·{@code content-length}·
 * {@code connection} 같은 전송 계층 헤더 제외, 순서는 무시)</li>
 * <li>대기: {@code {ms, afterRequests}} 목록을 정확히</li>
 * </ul>
 *
 * <p>
 * 의도된 차이(design D3): 헤더 순서(JDK {@code HttpClient}는 헤더를 해시 순서로 쓴다(예: {@code Cookie}가 맨 끝). 통제 불가), 타임아웃 유무, 리다이렉트를 따라가지 않음.
 */
class SourceContractTest {

	private static final JsonMapper JSON = JsonMapper.builder().build();

	/** 전송 계층이 정하는 헤더. 비교하지 않는다. */
	private static final Set<String> TRANSPORT_HEADERS = Set.of("host", "content-length", "connection");

	@TestFactory
	Stream<DynamicTest> 골든과_같은_결과_요청_대기를_낸다() throws IOException {
		Resource[] files = new PathMatchingResourcePatternResolver().getResources("classpath:contracts/source/*.json");
		assertThat(files).as("어댑터 골든 사례").hasSize(34);
		return Arrays.stream(files)
			.sorted(Comparator.comparing(Resource::getFilename))
			.map(file -> DynamicTest.dynamicTest(file.getFilename().replace(".json", ""), () -> verify(file)));
	}

	private void verify(Resource file) throws Exception {
		JsonNode golden;
		try (InputStream in = file.getInputStream()) {
			golden = JSON.readTree(in);
		}
		List<ReplayServer.Reply> replies = new ArrayList<>();
		for (JsonNode r : golden.get("responses")) {
			List<String> cookies = new ArrayList<>();
			r.path("setCookie").forEach(c -> cookies.add(c.asString()));
			replies.add(new ReplayServer.Reply(r.get("status").asInt(), cookies, r.get("body").asString(),
					r.path("closeSocket").asBoolean(false)));
		}

		try (ReplayServer server = new ReplayServer(replies)) {
			RecordingSleeper sleeper = new RecordingSleeper(() -> server.requests().size());
			Clock clock = Clock.fixed(Instant.parse(golden.get("now").asString()), ZoneOffset.UTC);
			CourtAuctionAdapter adapter = new CourtAuctionAdapter(options(golden.get("options"), server.baseUrl()), false,
					sleeper, clock);

			ArrayNode actual = JSON.createArrayNode();
			JsonNode call = golden.get("call");
			for (int i = 0; i < golden.get("repeat").asInt(); i++) {
				actual.add(outcome(adapter, call, server.baseUrl()));
			}

			String diff = ContractTest.diff("$.expected", golden.get("expected"), actual);
			assertThat(diff).as("결과 차이").isNull();
			assertRequests(golden.get("requests"), server);
			assertThat(ContractTest.diff("$.sleeps", golden.get("sleeps"), sleeps(sleeper))).as("대기 차이").isNull();
			assertThat(server.maxConcurrent()).as("동시 요청 최대값").isEqualTo(1);
		}
	}

	private static CourtAuctionOptions options(JsonNode node, String baseUrl) {
		CourtAuctionOptions o = CourtAuctionOptions.defaults().withBaseUrl(baseUrl);
		if (node.has("pageSize")) {
			o = o.withPageSize(node.get("pageSize").asInt());
		}
		if (node.has("pageDelayMs")) {
			o = o.withPageDelayMs(node.get("pageDelayMs").asLong());
		}
		if (node.has("maxPages")) {
			o = o.withMaxPages(node.get("maxPages").asInt());
		}
		if (node.has("bidWindowDays")) {
			o = new CourtAuctionOptions(o.baseUrl(), o.pageSize(), o.pageDelayMs(), node.get("bidWindowDays").asInt(),
					o.maxPages());
		}
		return o;
	}

	private static JsonNode outcome(CourtAuctionAdapter adapter, JsonNode call, String baseUrl) throws Exception {
		ObjectNode out = JSON.createObjectNode();
		try {
			if (call.get("kind").asString().equals("activeItems")) {
				List<CourtRef> courts = new ArrayList<>();
				call.get("scope").get("courts").forEach(c -> courts
					.add(new CourtRef(c.get("name").asString(), c.get("courtCode").asString())));
				FetchActiveItemsResult result = adapter.fetchActiveItems(new CollectScope(courts));
				out.set("items", JSON.valueToTree(result.items()));
				out.put("pagesRequested", result.pagesRequested());
			}
			else {
				JsonNode ref = call.get("ref");
				FetchItemPhotosResult result = adapter.fetchItemPhotos(
						new PhotoLookupRef(ref.get("courtCode").asString(), ref.get("internalCaseNo").asString()));
				ArrayNode photos = JSON.createArrayNode();
				MessageDigest sha = MessageDigest.getInstance("SHA-256");
				for (var p : result.photos()) {
					ObjectNode node = JSON.createObjectNode();
					node.put("seq", p.seq());
					node.put("base64Length", p.base64().length());
					node.put("base64Sha256", HexFormat.of().formatHex(sha.digest(p.base64().getBytes(StandardCharsets.UTF_8))));
					photos.add(node);
				}
				out.set("photos", photos);
				out.put("requestsMade", result.requestsMade());
			}
		}
		catch (SourceException e) {
			ObjectNode error = JSON.createObjectNode();
			error.put("kind", e.kind());
			error.put("requestsMade", e.requestsMade());
			error.put("messageHead", e.getMessage().split("\n", -1)[0].replace(baseUrl, "{base}"));
			out.set("error", error);
		}
		return out;
	}

	private static JsonNode sleeps(RecordingSleeper sleeper) {
		ArrayNode out = JSON.createArrayNode();
		for (var s : sleeper.sleeps()) {
			ObjectNode node = JSON.createObjectNode();
			node.put("ms", s.ms());
			node.put("afterRequests", s.afterRequests());
			out.add(node);
		}
		return out;
	}

	private static void assertRequests(JsonNode expected, ReplayServer server) throws Exception {
		List<ReplayServer.Recorded> actual = server.requests();
		assertThat(actual).as("요청 수").hasSize(expected.size());
		for (int i = 0; i < expected.size(); i++) {
			JsonNode e = expected.get(i);
			ReplayServer.Recorded a = actual.get(i);
			String at = "요청 " + i;
			assertThat(a.method()).as(at + " 메서드").isEqualTo(e.get("method").asString());
			assertThat(a.path()).as(at + " 경로").isEqualTo(e.get("path").asString());
			assertThat(headers(a, server)).as(at + " 헤더").isEqualTo(expectedHeaders(e.get("headers"), server));
			String body = e.get("body").asString();
			if (body.isEmpty()) {
				assertThat(a.body()).as(at + " 본문").isEmpty();
			}
			else {
				assertThat(ContractTest.diff("$.body", JSON.readTree(body.replace("{base}", server.baseUrl())),
						JSON.readTree(a.body())))
					.as(at + " 본문 차이")
					.isNull();
			}
		}
	}

	private static List<String> headers(ReplayServer.Recorded request, ReplayServer server) {
		return request.headers()
			.stream()
			.filter(h -> !TRANSPORT_HEADERS.contains(h[0].toLowerCase()))
			.map(h -> h[0].toLowerCase() + ": " + h[1])
			.sorted()
			.toList();
	}

	private static List<String> expectedHeaders(JsonNode headers, ReplayServer server) {
		List<String> out = new ArrayList<>();
		for (JsonNode h : headers) {
			String name = h.get(0).asString().toLowerCase();
			if (!TRANSPORT_HEADERS.contains(name)) {
				out.add(name + ": " + h.get(1).asString().replace("{base}", server.baseUrl()));
			}
		}
		return out.stream().sorted().toList();
	}

}
