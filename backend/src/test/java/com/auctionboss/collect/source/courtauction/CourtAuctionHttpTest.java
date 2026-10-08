package com.auctionboss.collect.source.courtauction;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.auctionboss.collect.source.ReplayServer;
import com.auctionboss.collect.source.SourceRequestException;
import java.io.ByteArrayOutputStream;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.zip.Deflater;
import java.util.zip.DeflaterOutputStream;
import java.util.zip.GZIPOutputStream;

import okhttp3.mockwebserver.MockResponse;
import okhttp3.mockwebserver.MockWebServer;
import okhttp3.mockwebserver.SocketPolicy;
import okio.Buffer;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

/** 2.2: 전송 형태(헤더, 본문), 직렬 요청, 타임아웃, 외부 요청 불허(design D3, D4). 전부 루프백이다. */
class CourtAuctionHttpTest {

	private static final String UA = "Mozilla/5.0 test";

	private static Map<String, String> headers() {
		Map<String, String> h = new LinkedHashMap<>();
		h.put("User-Agent", UA);
		h.put("Content-Type", "application/json;charset=UTF-8");
		h.put("Accept", "application/json");
		h.put("Cookie", "a=1");
		return h;
	}

	@Test
	void postSendsCallerHeadersPlusTheFetchDefaultsAndUtf8Body() throws Exception {
		try (ReplayServer server = new ReplayServer(List.of(ReplayServer.Reply.ok("{}")))) {
			CourtAuctionHttp http = new CourtAuctionHttp(false);

			CourtAuctionHttp.Response response = http.post(server.baseUrl() + "/p", headers(), "{\"k\":\"한글\"}");

			assertThat(response.status()).isEqualTo(200);
			assertThat(response.body()).isEqualTo("{}");
			ReplayServer.Recorded sent = server.requests().get(0);
			assertThat(sent.method()).isEqualTo("POST");
			assertThat(sent.path()).isEqualTo("/p");
			assertThat(sent.body()).isEqualTo("{\"k\":\"한글\"}");
			Map<String, String> byName = new LinkedHashMap<>();
			sent.headers().forEach(h -> byName.put(h[0].toLowerCase(), h[1]));
			assertThat(byName).containsEntry("user-agent", UA)
				.containsEntry("content-type", "application/json;charset=UTF-8")
				.containsEntry("accept", "application/json")
				.containsEntry("cookie", "a=1")
				.containsEntry("accept-language", "*")
				.containsEntry("sec-fetch-mode", "cors")
				.containsEntry("accept-encoding", "gzip, deflate")
				.containsEntry("content-length", String.valueOf("{\"k\":\"한글\"}".getBytes(StandardCharsets.UTF_8).length));
			assertThat(byName).doesNotContainKeys("origin", "referer");
		}
	}

	@Test
	void getHasNoBodyAndNoContentHeaders() throws Exception {
		try (ReplayServer server = new ReplayServer(List.of(ReplayServer.Reply.ok("<html/>")))) {
			new CourtAuctionHttp(false).get(server.baseUrl() + "/pgj/index.on", Map.of("User-Agent", UA));

			ReplayServer.Recorded sent = server.requests().get(0);
			assertThat(sent.method()).isEqualTo("GET");
			assertThat(sent.body()).isEmpty();
			assertThat(sent.headers().stream().map(h -> h[0].toLowerCase())).doesNotContain("content-type", "content-length");
		}
	}

	@Test
	void requestsAreSequentialSoTheServerNeverSeesTwoAtOnce() throws Exception {
		try (ReplayServer server = new ReplayServer(List.of(ReplayServer.Reply.ok("1"), ReplayServer.Reply.ok("2"),
				ReplayServer.Reply.ok("3")))) {
			CourtAuctionHttp http = new CourtAuctionHttp(false);
			for (int i = 0; i < 3; i++) {
				http.post(server.baseUrl() + "/p", headers(), "{}");
			}

			assertThat(server.requests()).hasSize(3);
			assertThat(server.maxConcurrent()).isEqualTo(1);
		}
	}

	@Test
	void redirectsAreNotFollowed() throws Exception {
		try (MockWebServer server = new MockWebServer()) {
			server.enqueue(new MockResponse().setResponseCode(302).addHeader("Location", "http://127.0.0.1:1/elsewhere"));
			server.start(java.net.InetAddress.getLoopbackAddress(), 0);

			CourtAuctionHttp.Response response = new CourtAuctionHttp(false)
				.get(server.url("/x").toString(), Map.of("User-Agent", UA));

			assertThat(response.status()).isEqualTo(302);
			assertThat(response.ok()).isFalse();
			assertThat(server.getRequestCount()).isEqualTo(1);
		}
	}

	@Test
	void gzipDeflateAndRawDeflateBodiesAreDecompressedAndTheBomIsDropped() throws Exception {
		try (MockWebServer server = new MockWebServer()) {
			server.enqueue(new MockResponse().addHeader("Content-Encoding", "gzip").setBody(new Buffer().write(gzip("{\"가\":1}"))));
			server.enqueue(new MockResponse().addHeader("Content-Encoding", "deflate").setBody(new Buffer().write(deflate("{\"나\":2}", false))));
			server.enqueue(new MockResponse().addHeader("Content-Encoding", "deflate").setBody(new Buffer().write(deflate("{\"다\":3}", true))));
			server.enqueue(new MockResponse().setBody(new Buffer().writeUtf8("﻿{\"라\":4}")));
			server.start(java.net.InetAddress.getLoopbackAddress(), 0);
			CourtAuctionHttp http = new CourtAuctionHttp(false);
			String url = server.url("/x").toString();

			assertThat(http.get(url, Map.of()).body()).isEqualTo("{\"가\":1}");
			assertThat(http.get(url, Map.of()).body()).isEqualTo("{\"나\":2}");
			assertThat(http.get(url, Map.of()).body()).isEqualTo("{\"다\":3}");
			assertThat(http.get(url, Map.of()).body()).isEqualTo("{\"라\":4}");
		}
	}

	@Test
	void setCookiesAreReturnedOnePerHeader() throws Exception {
		try (ReplayServer server = new ReplayServer(
				List.of(new ReplayServer.Reply(200, List.of("A=1; Path=/", "B=2; HttpOnly"), "x", false)))) {
			CourtAuctionHttp.Response response = new CourtAuctionHttp(false).get(server.baseUrl() + "/", Map.of());

			assertThat(response.setCookies()).containsExactly("A=1; Path=/", "B=2; HttpOnly");
		}
	}

	@Test
	void aResponseThatNeverComesTimesOutAsASourceRequestError() throws Exception {
		try (MockWebServer server = new MockWebServer()) {
			server.enqueue(new MockResponse().setSocketPolicy(SocketPolicy.NO_RESPONSE));
			server.start(java.net.InetAddress.getLoopbackAddress(), 0);
			CourtAuctionHttp http = new CourtAuctionHttp(false, Duration.ofSeconds(2), Duration.ofMillis(300));
			String url = server.url("/slow").toString();

			assertThatThrownBy(() -> http.get(url, Map.of())).isInstanceOfSatisfying(SourceRequestException.class, e -> {
				assertThat(e.kind()).isEqualTo("SourceRequestError");
				assertThat(e.getMessage()).contains("네트워크 오류").contains(url);
				assertThat(e.getCause()).isInstanceOf(java.net.http.HttpTimeoutException.class);
			});
		}
	}

	@Test
	@org.junit.jupiter.api.Timeout(15)
	void aBodyThatNeverEndsTimesOutAsASourceRequestError() throws Exception {
		// 헤더는 바로 오고 본문이 초당 몇 바이트씩만 흐른다. HttpRequest.timeout만으로는 이 경우 멈추지 않는다.
		try (MockWebServer server = new MockWebServer()) {
			server.enqueue(new MockResponse().setBody("x".repeat(100_000)).throttleBody(10, 1, java.util.concurrent.TimeUnit.SECONDS));
			server.start(java.net.InetAddress.getLoopbackAddress(), 0);
			CourtAuctionHttp http = new CourtAuctionHttp(false, Duration.ofSeconds(2), Duration.ofMillis(500));
			String url = server.url("/drip").toString();
			long start = System.nanoTime();

			assertThatThrownBy(() -> http.get(url, Map.of())).isInstanceOfSatisfying(SourceRequestException.class, e -> {
				assertThat(e.kind()).isEqualTo("SourceRequestError");
				assertThat(e.getMessage()).contains("네트워크 오류").contains(url);
				assertThat(e.getCause()).isInstanceOf(java.net.http.HttpTimeoutException.class);
			});
			assertThat(Duration.ofNanos(System.nanoTime() - start)).isLessThan(Duration.ofSeconds(5));
		}
	}

	@Test
	void aDroppedConnectionIsASourceRequestError() throws Exception {
		try (MockWebServer server = new MockWebServer()) {
			server.enqueue(new MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST));
			server.start(java.net.InetAddress.getLoopbackAddress(), 0);

			assertThatThrownBy(() -> new CourtAuctionHttp(false).get(server.url("/x").toString(), Map.of()))
				.isInstanceOf(SourceRequestException.class);
		}
	}

	// ------------------------------------------------------------- 외부 요청 불허 (D4)

	@ParameterizedTest
	@ValueSource(strings = { "http://example.invalid/pgj/index.on", "https://www.courtauction.go.kr/pgj/index.on",
			"http://192.0.2.1:81/x", "http://10.0.0.1/x", "http://[2001:db8::1]/x", "http://localhost.evil.com/x",
			"http://127.0.0.1.evil.com/x", "ftp://127.0.0.1/x", "http://128.0.0.1/x", "http://0.0.0.0/x",
			"http://999.1.1.1/x", "http://127.0.0.256/x", "http://[::]/x", "http://[::ffff:8.8.8.8]/x",
			"http://127.0.0.1@evil.example/x", "http://127.1/x" })
	void nonLoopbackTargetsAreRefusedBeforeAnySocketIsOpened(String url) {
		CourtAuctionHttp http = new CourtAuctionHttp(false);
		long start = System.nanoTime();

		assertThatThrownBy(() -> http.get(url, Map.of())).isInstanceOfSatisfying(SourceRequestException.class, e -> {
			assertThat(e.kind()).isEqualTo("SourceRequestError");
			assertThat(e.getMessage()).startsWith("외부 요청이 허용되지 않았습니다");
			assertThat(e.getCause()).isNull();
		});

		// 소켓을 열었다면 연결 시도(DNS, 10초 타임아웃)를 거쳤을 것이다.
		assertThat(Duration.ofNanos(System.nanoTime() - start)).isLessThan(Duration.ofSeconds(1));
	}

	@ParameterizedTest
	@ValueSource(strings = { "http://127.0.0.1:9/x", "http://127.1.2.3/x", "http://localhost:9/x", "http://LOCALHOST/x",
			"http://[::1]:9/x", "https://127.0.0.1/x" })
	void loopbackTargetsPassTheCheck(String url) {
		assertThat(CourtAuctionHttp.isLoopback(URI.create(url))).isTrue();
	}

	@Test
	void loopbackTargetsAreReachableWhenExternalRequestsAreNotAllowed() throws Exception {
		try (ReplayServer server = new ReplayServer(List.of(ReplayServer.Reply.ok("ok")))) {
			assertThat(new CourtAuctionHttp(false).get(server.baseUrl() + "/", Map.of()).body()).isEqualTo("ok");
		}
	}

	@Test
	void whenAllowedTheLoopbackCheckIsSkipped() {
		// 허용을 켜면 검사를 건너뛴다. 실제 연결이 나가지 않도록 JDK가 소켓 전에 거절하는 스킴(ftp)으로 확인한다:
		// 허용 꺼짐이면 "허용되지 않았습니다"(위 테스트), 켜지면 검사를 지나 전송 단계의 오류가 된다.
		CourtAuctionHttp http = new CourtAuctionHttp(true, Duration.ofMillis(200), Duration.ofMillis(200));

		assertThatThrownBy(() -> http.get("ftp://127.0.0.1/x", Map.of())).isInstanceOfSatisfying(SourceRequestException.class,
				e -> {
					assertThat(e.getMessage()).doesNotContain("허용되지 않았습니다").contains("네트워크 오류");
					assertThat(e.getCause()).isNotNull();
				});
	}

	// ------------------------------------------------------------- 쿠키

	@Test
	void cookieHeaderKeepsFirstSeenOrderAndLastValueAndSkipsMalformedEntries() {
		List<String> setCookies = List.of("JSESSIONID=abc; Path=/; HttpOnly", "WMONID=w1; Path=/", "=novalue",
				"noequals", "  ; x=y", "JSESSIONID=def; Path=/", "empty=");

		assertThat(CourtAuctionHttp.readCookieHeader(setCookies)).isEqualTo("JSESSIONID=def; WMONID=w1; empty=");
		assertThat(CourtAuctionHttp.readCookieHeader(List.of())).isEmpty();
	}

	private static byte[] gzip(String text) throws Exception {
		ByteArrayOutputStream out = new ByteArrayOutputStream();
		try (GZIPOutputStream gz = new GZIPOutputStream(out)) {
			gz.write(text.getBytes(StandardCharsets.UTF_8));
		}
		return out.toByteArray();
	}

	private static byte[] deflate(String text, boolean raw) throws Exception {
		ByteArrayOutputStream out = new ByteArrayOutputStream();
		try (DeflaterOutputStream d = new DeflaterOutputStream(out, new Deflater(Deflater.DEFAULT_COMPRESSION, raw))) {
			d.write(text.getBytes(StandardCharsets.UTF_8));
		}
		return out.toByteArray();
	}

}
