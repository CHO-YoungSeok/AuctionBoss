package com.auctionboss.collect.source;

import java.io.IOException;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;

import okhttp3.Headers;
import okhttp3.mockwebserver.Dispatcher;
import okhttp3.mockwebserver.MockResponse;
import okhttp3.mockwebserver.MockWebServer;
import okhttp3.mockwebserver.RecordedRequest;
import okhttp3.mockwebserver.SocketPolicy;
import okio.Buffer;

/**
 * 루프백 재생 서버(MockWebServer). 준비한 응답을 받은 순서대로 한 번씩 돌려주고 받은 요청을 기록한다. 외부 사이트에는 요청하지 않는다.
 * 준비한 응답보다 요청이 많으면 500과 안내 문구를 돌려준다(테스트 작성 실수를 드러내기 위해).
 */
public final class ReplayServer implements AutoCloseable {

	/** 재생할 응답 하나. */
	public record Reply(int status, List<String> setCookies, String body, boolean closeSocket) {

		public static Reply ok(String body) {
			return new Reply(200, List.of(), body, false);
		}

	}

	/** 받은 요청. 헤더는 받은 순서·대소문자 그대로의 [이름, 값] 쌍이다. */
	public record Recorded(String method, String path, List<String[]> headers, String body) {
	}

	private final MockWebServer server = new MockWebServer();

	private final List<Recorded> requests = Collections.synchronizedList(new ArrayList<>());

	private final AtomicInteger inFlight = new AtomicInteger();

	private final AtomicInteger maxConcurrent = new AtomicInteger();

	public ReplayServer(List<Reply> replies) throws IOException {
		AtomicInteger next = new AtomicInteger();
		server.setDispatcher(new Dispatcher() {
			@Override
			public MockResponse dispatch(RecordedRequest request) {
				int now = inFlight.incrementAndGet();
				maxConcurrent.accumulateAndGet(now, Math::max);
				try {
					Headers headers = request.getHeaders();
					List<String[]> pairs = new ArrayList<>();
					for (int i = 0; i < headers.size(); i++) {
						pairs.add(new String[] { headers.name(i), headers.value(i) });
					}
					requests.add(new Recorded(request.getMethod(), request.getPath(), pairs,
							request.getBody().readUtf8()));
					int index = next.getAndIncrement();
					if (index >= replies.size()) {
						return new MockResponse().setResponseCode(500).setBody("재생할 응답이 없습니다");
					}
					Reply reply = replies.get(index);
					if (reply.closeSocket()) {
						return new MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST);
					}
					MockResponse response = new MockResponse().setResponseCode(reply.status())
						.addHeader("Content-Type", "application/json;charset=UTF-8")
						.setBody(new Buffer().writeUtf8(reply.body()));
					reply.setCookies().forEach(c -> response.addHeader("Set-Cookie", c));
					return response;
				}
				finally {
					inFlight.decrementAndGet();
				}
			}
		});
		server.start(java.net.InetAddress.getLoopbackAddress(), 0);
	}

	/** {@code http://127.0.0.1:<포트>} (끝에 슬래시 없음). */
	public String baseUrl() {
		String url = server.url("/").toString();
		return url.substring(0, url.length() - 1);
	}

	/** {@code 127.0.0.1:<포트>}. */
	public String host() {
		return server.getHostName() + ":" + server.getPort();
	}

	public List<Recorded> requests() {
		return List.copyOf(requests);
	}

	public int maxConcurrent() {
		return maxConcurrent.get();
	}

	@Override
	public void close() throws IOException {
		server.shutdown();
	}

}
