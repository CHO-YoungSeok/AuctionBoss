package com.auctionboss.collect.source.courtauction;

import com.auctionboss.collect.source.SourceRequestException;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.InetAddress;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.net.http.HttpTimeoutException;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.regex.Pattern;
import java.util.zip.GZIPInputStream;
import java.util.zip.Inflater;
import java.util.zip.InflaterInputStream;

/**
 * 소스 HTTP 전송. JDK {@link HttpClient}를 쓰는 유일한 곳이다(HTTP/1.1 고정, 리다이렉트 따라가지 않음, 연결 10초·응답 60초 타임아웃).
 *
 * <p>
 * 요청 형식은 Node {@code fetch}(undici)가 실제로 보낸 것과 같게 맞춘다. WAF가 User-Agent로 차단한 실측이 있어 헤더 차이가 차단 조건이
 * 될 수 있다. 코드가 정한 헤더(호출자가 넘김) 뒤에 undici가 붙이는 {@code accept-language: *}, {@code sec-fetch-mode: cors},
 * {@code accept-encoding: gzip, deflate}를 같은 값으로 붙이고, 응답의 gzip·deflate는 푼다. {@code host}·{@code content-length}는 JDK가 쓴다.
 *
 * <p>
 * 외부 요청 안전장치(design D4): 허용 설정이 꺼져 있으면 매 요청 전에 대상 호스트가 루프백인지 보고, 아니면 소켓을 열기 전에
 * {@link SourceRequestException}으로 거절한다(차단이 아니므로 백오프를 걸지 않는다).
 */
final class CourtAuctionHttp {

	/** 응답. {@code setCookies}는 {@code Set-Cookie} 헤더 값 전부(헤더마다 하나). */
	record Response(int status, String body, List<String> setCookies) {

		boolean ok() {
			return status >= 200 && status < 300;
		}

	}

	static final Duration CONNECT_TIMEOUT = Duration.ofSeconds(10);

	static final Duration RESPONSE_TIMEOUT = Duration.ofSeconds(60);

	private static final Pattern IPV4 = Pattern.compile("\\d{1,3}(?:\\.\\d{1,3}){3}");

	private final HttpClient client;

	private final boolean externalRequestsAllowed;

	private final Duration responseTimeout;

	CourtAuctionHttp(boolean externalRequestsAllowed) {
		this(externalRequestsAllowed, CONNECT_TIMEOUT, RESPONSE_TIMEOUT);
	}

	CourtAuctionHttp(boolean externalRequestsAllowed, Duration connectTimeout, Duration responseTimeout) {
		this.client = HttpClient.newBuilder()
			.version(HttpClient.Version.HTTP_1_1)
			.followRedirects(HttpClient.Redirect.NEVER)
			.connectTimeout(connectTimeout)
			.build();
		this.externalRequestsAllowed = externalRequestsAllowed;
		this.responseTimeout = responseTimeout;
	}

	Response get(String url, Map<String, String> headers) {
		return send(url, headers, null);
	}

	Response post(String url, Map<String, String> headers, String body) {
		return send(url, headers, body);
	}

	private Response send(String url, Map<String, String> headers, String body) {
		URI uri = toUri(url);
		if (!externalRequestsAllowed && !isLoopback(uri)) {
			throw new SourceRequestException("외부 요청이 허용되지 않았습니다: " + url, url);
		}
		try {
			HttpRequest.Builder request = HttpRequest.newBuilder(uri).timeout(responseTimeout);
			Map<String, String> all = new LinkedHashMap<>(headers);
			all.put("accept-language", "*");
			all.put("sec-fetch-mode", "cors");
			all.put("accept-encoding", "gzip, deflate");
			all.forEach(request::header);
			if (body == null) {
				request.GET(); // GET에는 본문 관련 헤더(content-length: 0)를 붙이지 않는다(Node fetch와 같다).
			}
			else {
				request.POST(HttpRequest.BodyPublishers.ofString(body, StandardCharsets.UTF_8));
			}

			// HttpRequest.timeout은 응답 헤더 수신까지만 잰다. 헤더만 보내고 본문을 늘어뜨리는 서버에 회차가 멈추지 않도록
			// 요청 전체(본문 포함)에 같은 마감을 건다. 마감이 지나면 교환을 취소한다.
			CompletableFuture<HttpResponse<byte[]>> pending = client.sendAsync(request.build(),
					HttpResponse.BodyHandlers.ofByteArray());
			HttpResponse<byte[]> response;
			try {
				response = pending.get(responseTimeout.toMillis(), TimeUnit.MILLISECONDS);
			}
			catch (TimeoutException e) {
				pending.cancel(true);
				throw new HttpTimeoutException("응답 전체(본문 포함)가 " + responseTimeout.toMillis() + "ms 안에 끝나지 않았습니다");
			}
			catch (ExecutionException e) {
				pending.cancel(true);
				Throwable cause = e.getCause() == null ? e : e.getCause();
				throw cause instanceof IOException io ? io : new IOException(cause);
			}
			String text = decode(response.body(), response.headers().firstValue("content-encoding").orElse(""));
			return new Response(response.statusCode(), text, response.headers().allValues("set-cookie"));
		}
		catch (InterruptedException e) {
			Thread.currentThread().interrupt();
			throw networkError(url, e);
		}
		catch (IOException | RuntimeException e) {
			if (e instanceof SourceRequestException source) {
				throw source;
			}
			throw networkError(url, e);
		}
	}

	private static SourceRequestException networkError(String url, Throwable cause) {
		return new SourceRequestException("요청 중 네트워크 오류가 발생했습니다: " + url, url, null, cause);
	}

	private static URI toUri(String url) {
		try {
			return URI.create(url);
		}
		catch (IllegalArgumentException e) {
			throw networkError(url, e);
		}
	}

	/** 대상이 루프백({@code 127.0.0.0/8}, {@code ::1}, {@code localhost})인지. 이름 조회(DNS)는 하지 않는다. */
	static boolean isLoopback(URI uri) {
		String scheme = uri.getScheme();
		if (!"http".equalsIgnoreCase(scheme) && !"https".equalsIgnoreCase(scheme)) {
			return false;
		}
		String host = uri.getHost();
		if (host == null) {
			return false;
		}
		if (host.equalsIgnoreCase("localhost")) {
			return true;
		}
		// 이름 조회(DNS)가 일어나지 않도록 직접 판정한다: IPv4는 옥텟 4개(각 0~255)만, IPv6는 ':'가 있는 리터럴만 JDK에 넘긴다.
		// (JDK는 "999.1.1.1" 같은 숫자꼴 이름을 리터럴로 못 읽으면 호스트 이름으로 조회할 수 있다.)
		if (IPV4.matcher(host).matches()) {
			String[] octets = host.split("\\.");
			for (String octet : octets) {
				if (Integer.parseInt(octet) > 255) {
					return false;
				}
			}
			return Integer.parseInt(octets[0]) == 127;
		}
		if (host.startsWith("[") && host.endsWith("]") && host.indexOf(':') > 0 && host.indexOf('%') < 0) {
			try {
				return InetAddress.getByName(host.substring(1, host.length() - 1)).isLoopbackAddress();
			}
			catch (IOException e) {
				return false;
			}
		}
		return false;
	}

	/** 응답 본문을 UTF-8 문자열로. gzip·deflate는 푼다(여러 개면 적용된 반대 순서). 앞의 BOM은 {@code fetch().text()}처럼 지운다. */
	private static String decode(byte[] body, String contentEncoding) throws IOException {
		byte[] bytes = body;
		List<String> encodings = new ArrayList<>();
		for (String part : contentEncoding.split(",")) {
			String e = part.trim().toLowerCase(Locale.ROOT);
			if (!e.isEmpty() && !e.equals("identity")) {
				encodings.add(e);
			}
		}
		for (int i = encodings.size() - 1; i >= 0; i--) {
			String e = encodings.get(i);
			if (e.equals("gzip") || e.equals("x-gzip")) {
				bytes = readAll(new GZIPInputStream(new ByteArrayInputStream(bytes)));
			}
			else if (e.equals("deflate")) {
				bytes = inflate(bytes);
			}
			else {
				throw new IOException("지원하지 않는 Content-Encoding: " + e);
			}
		}
		String text = new String(bytes, StandardCharsets.UTF_8);
		return text.startsWith("﻿") ? text.substring(1) : text;
	}

	/** deflate는 zlib 래퍼가 있는 것과 없는 것이 모두 쓰인다. */
	private static byte[] inflate(byte[] bytes) throws IOException {
		try {
			return readAll(new InflaterInputStream(new ByteArrayInputStream(bytes)));
		}
		catch (IOException zlibFailed) {
			return readAll(new InflaterInputStream(new ByteArrayInputStream(bytes), new Inflater(true)));
		}
	}

	private static byte[] readAll(InputStream in) throws IOException {
		try (in) {
			return in.readAllBytes();
		}
	}

	/** 응답 헤더의 {@code Set-Cookie}들을 {@code name=value; name=value}로 모은다. 같은 이름은 나중 값이 이긴다(위치는 처음 것). */
	static String readCookieHeader(List<String> setCookies) {
		Map<String, String> jar = new LinkedHashMap<>();
		for (String entry : setCookies) {
			String pair = JsValues.trim(entry.split(";", 2)[0]);
			if (pair.isEmpty()) {
				continue;
			}
			int eq = pair.indexOf('=');
			if (eq <= 0) {
				continue;
			}
			jar.put(pair.substring(0, eq), pair.substring(eq + 1));
		}
		List<String> parts = new ArrayList<>();
		jar.forEach((name, value) -> parts.add(name + "=" + value));
		return String.join("; ", parts);
	}

}
