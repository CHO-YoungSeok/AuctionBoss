package com.auctionboss.collect.source.courtauction;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.auctionboss.collect.source.CollectScope;
import com.auctionboss.collect.source.CourtRef;
import com.auctionboss.collect.source.FetchItemPhotosResult;
import com.auctionboss.collect.source.PhotoLookupRef;
import com.auctionboss.collect.source.RecordingSleeper;
import com.auctionboss.collect.source.ReplayServer;
import com.auctionboss.collect.source.ReplayServer.Reply;
import com.auctionboss.collect.source.SourceException;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.List;

import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/** 2.5 보조: 골든이 덮지 않는 어댑터 경계(사진 순번 변환, 매각기일 창, 세션 수명, 기본 옵션). 골든 재생은 {@code SourceContractTest}. */
class CourtAuctionAdapterTest {

	private static final JsonMapper JSON = JsonMapper.builder().build();

	private static final Clock CLOCK = Clock.fixed(Instant.parse("2026-12-20T12:00:00Z"), ZoneOffset.UTC);

	private static final PhotoLookupRef REF = new PhotoLookupRef("B000210", "20260130101037");

	private static final CollectScope SCOPE = new CollectScope(List.of(new CourtRef("서울중앙지방법원", "B000210")));

	private static Reply session() {
		return new Reply(200, List.of("JSESSIONID=s1; Path=/"), "<html/>", false);
	}

	private static Reply detail(String pics) {
		return Reply.ok("{\"data\":{\"ipcheck\":true,\"dma_result\":{\"csBaseInfo\":{},\"csPicLst\":" + pics + "}}}");
	}

	private static Reply emptySearch() {
		return Reply.ok("{\"data\":{\"ipcheck\":true,\"dma_pageInfo\":{\"totalCnt\":\"0\"},\"dlt_srchResult\":[]}}");
	}

	private static CourtAuctionAdapter adapter(ReplayServer server, RecordingSleeper sleeper) {
		return new CourtAuctionAdapter(CourtAuctionOptions.defaults().withBaseUrl(server.baseUrl()), false, sleeper, CLOCK);
	}

	@Test
	void photoSeqIsReadLikeJavaScriptNumberAndEntriesWithoutImageDataAreSkipped() throws Exception {
		String pics = "[{\"cortAuctnPicSeq\":\"\",\"picFile\":\"A\"},{\"cortAuctnPicSeq\":\" 7 \",\"picFile\":\"B\"},"
				+ "{\"cortAuctnPicSeq\":\"x\",\"picFile\":\"C\"},{\"cortAuctnPicSeq\":3.0,\"picFile\":\"D\"},"
				+ "{\"cortAuctnPicSeq\":\"Infinity\",\"picFile\":\"E\"},{\"picFile\":\"F\"},{\"cortAuctnPicSeq\":9,\"picFile\":\"\"}]";
		try (ReplayServer server = new ReplayServer(List.of(session(), detail(pics)))) {
			FetchItemPhotosResult result = adapter(server, new RecordingSleeper(() -> 0)).fetchItemPhotos(REF);

			// Number("")는 0이라 포함된다(TS와 같다). 숫자가 아니거나 유한하지 않거나 순번이 없는 항목, 이미지가 빈 항목은 제외한다.
			assertThat(result.photos()).extracting(p -> p.seq() + ":" + p.base64()).containsExactly("0:A", "7:B", "3:D");
			assertThat(result.requestsMade()).isEqualTo(2);
		}
	}

	@Test
	void theDetailRequestBodyCarriesTheCaseAndCourtIdentifiersAndTheSessionCookie() throws Exception {
		try (ReplayServer server = new ReplayServer(List.of(session(), detail("[]")))) {
			adapter(server, new RecordingSleeper(() -> 0)).fetchItemPhotos(REF);

			ReplayServer.Recorded post = server.requests().get(1);
			JsonNode body = JSON.readTree(post.body());
			assertThat(body.get("dma_srchGdsDtlSrch").get("csNo").asString()).isEqualTo("20260130101037");
			assertThat(body.get("dma_srchGdsDtlSrch").get("cortOfcCd").asString()).isEqualTo("B000210");
			assertThat(body.get("dma_srchGdsDtlSrch").get("dspslGdsSeq").asString()).isEmpty();
			assertThat(post.headers().stream().filter(h -> h[0].equals("Cookie")).map(h -> h[1])).containsExactly("JSESSIONID=s1");
		}
	}

	@Test
	void aFailedPhotoBootstrapCountsTheRequestAndTheNextCallBootstrapsAgain() throws Exception {
		try (ReplayServer server = new ReplayServer(
				List.of(new Reply(500, List.of(), "err", false), session(), detail("[]")))) {
			CourtAuctionAdapter adapter = adapter(server, new RecordingSleeper(() -> 0));

			assertThatThrownBy(() -> adapter.fetchItemPhotos(REF)).isInstanceOfSatisfying(SourceException.class,
					e -> assertThat(e.requestsMade()).isEqualTo(1));
			assertThat(adapter.fetchItemPhotos(REF).requestsMade()).isEqualTo(2);
			assertThat(server.requests()).extracting(ReplayServer.Recorded::path)
				.containsExactly("/pgj/index.on", "/pgj/index.on", "/pgj/pgj15B/selectAuctnCsSrchRslt.on");
		}
	}

	@Test
	void everySearchCallBootstrapsANewSessionButPhotosKeepTheirOwn() throws Exception {
		try (ReplayServer server = new ReplayServer(List.of(session(), emptySearch(), session(), emptySearch()))) {
			CourtAuctionAdapter adapter = adapter(server, new RecordingSleeper(() -> 0));

			adapter.fetchActiveItems(SCOPE);
			adapter.fetchActiveItems(SCOPE);

			assertThat(server.requests()).extracting(ReplayServer.Recorded::path).containsExactly("/pgj/index.on",
					"/pgj/pgjsearch/searchControllerMain.on", "/pgj/index.on", "/pgj/pgjsearch/searchControllerMain.on");
		}
	}

	@Test
	void theBidWindowIsTodayThroughSixtyDaysLaterAcrossAYearBoundary() throws Exception {
		try (ReplayServer server = new ReplayServer(List.of(session(), emptySearch()))) {
			adapter(server, new RecordingSleeper(() -> 0)).fetchActiveItems(SCOPE);

			JsonNode info = JSON.readTree(server.requests().get(1).body()).get("dma_srchGdsDtlSrchInfo");
			assertThat(info.get("bidBgngYmd").asString()).isEqualTo("20261220");
			assertThat(info.get("bidEndYmd").asString()).isEqualTo("20270218");
		}
	}

	@Test
	void theDefaultPageDelayIsFiveSecondsAndNoSleepHappensForASingleCourtSinglePage() throws Exception {
		assertThat(CourtAuctionOptions.defaults().pageDelayMs()).isEqualTo(5_000);
		assertThat(CourtAuctionOptions.defaults().pageSize()).isEqualTo(40);
		assertThat(CourtAuctionOptions.defaults().maxPages()).isEqualTo(50);
		assertThat(CourtAuctionOptions.defaults().bidWindowDays()).isEqualTo(60);
		try (ReplayServer server = new ReplayServer(List.of(session(), emptySearch()))) {
			RecordingSleeper sleeper = new RecordingSleeper(() -> server.requests().size());

			adapter(server, sleeper).fetchActiveItems(SCOPE);

			assertThat(sleeper.sleeps()).isEmpty();
		}
	}

	@Test
	void aZeroResultSearchIsAnEmptyListNotAFailure() throws Exception {
		try (ReplayServer server = new ReplayServer(List.of(session(), emptySearch()))) {
			var result = adapter(server, new RecordingSleeper(() -> 0)).fetchActiveItems(SCOPE);

			assertThat(result.items()).isEmpty();
			assertThat(result.pagesRequested()).isEqualTo(1);
		}
	}

	@Test
	void anAdapterPointedAtARealAddressRefusesWithoutAnyRequestWhenExternalRequestsAreNotAllowed() {
		CourtAuctionAdapter adapter = new CourtAuctionAdapter(CourtAuctionOptions.defaults(), false, ms -> {
			throw new AssertionError("대기하면 안 된다");
		}, CLOCK);

		assertThatThrownBy(() -> adapter.fetchActiveItems(SCOPE)).isInstanceOfSatisfying(SourceException.class, e -> {
			assertThat(e.kind()).isEqualTo("SourceRequestError");
			assertThat(e.getMessage()).startsWith("외부 요청이 허용되지 않았습니다");
			assertThat(e.requestsMade()).isZero();
		});
		assertThatThrownBy(() -> adapter.fetchItemPhotos(REF)).isInstanceOfSatisfying(SourceException.class,
				e -> assertThat(e.getMessage()).startsWith("외부 요청이 허용되지 않았습니다"));
	}

}
