package com.auctionboss.collect.source.courtauction;

import com.auctionboss.collect.source.AuctionSource;
import com.auctionboss.collect.source.CollectScope;
import com.auctionboss.collect.source.CourtRef;
import com.auctionboss.collect.source.FetchActiveItemsResult;
import com.auctionboss.collect.source.FetchItemPhotosResult;
import com.auctionboss.collect.source.PhotoLookupRef;
import com.auctionboss.collect.source.Sleeper;
import com.auctionboss.collect.source.SourceException;
import com.auctionboss.collect.source.SourceItem;
import com.auctionboss.collect.source.SourcePhoto;
import com.auctionboss.collect.source.SourceRequestException;
import java.time.Clock;
import java.time.LocalDate;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import tools.jackson.databind.node.ObjectNode;

/**
 * 법원경매정보(courtauction.go.kr) 수집 어댑터. TS {@code CourtAuctionAdapter}를 같은 요청·같은 간격·같은 결과로 옮긴 것이다.
 *
 * <ol>
 * <li>{@code GET /pgj/index.on} 1회로 세션 쿠키를 받는다(검색은 호출마다, 사진은 인스턴스당 1회)</li>
 * <li>{@code POST /pgj/pgjsearch/searchControllerMain.on}를 {@code pageNo}만 늘리며 순차로 돈다. 페이지 수는 {@code totalCnt}(행 수)로
 * 계산한다</li>
 * <li>매 응답을 3단(본문 첫 글자, {@code ipcheck}, 형식)으로 검사한다</li>
 * <li>행을 (법원, 사건번호, 물건번호) 물건 단위로 접는다</li>
 * </ol>
 *
 * 요청은 전부 직렬이고 페이지 사이에 {@link Sleeper}로 쉰다. 실패는 {@link SourceException}으로 던지고, 그때까지 실제로 보낸 요청 수를 오류에 싣는다.
 */
public final class CourtAuctionAdapter implements AuctionSource {

	static final String SESSION_BOOTSTRAP_PATH = "/pgj/index.on";

	static final String SEARCH_PATH = "/pgj/pgjsearch/searchControllerMain.on";

	static final String DETAIL_PATH = "/pgj/pgj15B/selectAuctnCsSrchRslt.on";

	/** 브라우저 User-Agent. curl 기본 UA는 WAF가 HTML 차단 페이지로 막는다(실측). */
	static final String USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

	private static final String SEARCH_COND_REALTY = "0004601";

	private static final String MOVABLE_REALTY_DIVISION_REALTY = "00031R";

	private static final String COURT_STANDARD_DIVISION = "1";

	private static final String BID_DIVISION_CODE = "000331";

	private static final String PROGRAM_ID = "PGJ15AF01";

	private static final DateTimeFormatter YMD = DateTimeFormatter.BASIC_ISO_DATE;

	private static final Logger log = LoggerFactory.getLogger(CourtAuctionAdapter.class);

	private final CourtAuctionHttp http;

	private final String baseUrl;

	private final int pageSize;

	private final long pageDelayMs;

	private final int bidWindowDays;

	private final int maxPages;

	private final Sleeper sleeper;

	private final Clock clock;

	/** 사진 조회용 세션. 인스턴스 안에서 첫 호출 때 한 번 만들고 재사용한다. */
	private String photoCookie;

	CourtAuctionAdapter(CourtAuctionHttp http, CourtAuctionOptions options, Sleeper sleeper, Clock clock) {
		this.http = http;
		this.baseUrl = options.baseUrl();
		this.pageSize = clampPageSize(options.pageSize());
		this.pageDelayMs = options.pageDelayMs();
		this.bidWindowDays = options.bidWindowDays();
		this.maxPages = options.maxPages();
		this.sleeper = sleeper;
		this.clock = clock;
	}

	/** 외부 요청 허용 여부를 받아 HTTP 클라이언트까지 만든다. */
	public CourtAuctionAdapter(CourtAuctionOptions options, boolean externalRequestsAllowed, Sleeper sleeper,
			Clock clock) {
		this(new CourtAuctionHttp(externalRequestsAllowed), options, sleeper, clock);
	}

	/** 서버가 거부하는 큰 pageSize를 조용히 무시하지 않고 경고와 함께 40으로 낮춘다. */
	private static int clampPageSize(int requested) {
		int size = Math.max(1, requested);
		if (size <= CourtAuctionOptions.MAX_PAGE_SIZE) {
			return size;
		}
		log.warn("[courtauction] pageSize={}는 서버가 거부합니다(HTTP 400). {}로 낮춥니다.", size,
				CourtAuctionOptions.MAX_PAGE_SIZE);
		return CourtAuctionOptions.MAX_PAGE_SIZE;
	}

	@Override
	public FetchActiveItemsResult fetchActiveItems(CollectScope scope) {
		// 회차당 쿠키는 한 번만 받는다.
		String cookie = bootstrapSession();

		List<SourceItem> items = new ArrayList<>();
		int pagesRequested = 0;
		List<CourtRef> courts = scope.courts();
		for (int index = 0; index < courts.size(); index++) {
			CourtRef court = courts.get(index);
			if (index > 0) {
				sleeper.sleep(pageDelayMs);
			}
			try {
				CourtRows result = fetchCourtRows(court, cookie);
				pagesRequested += result.pagesRequested();
				items.addAll(RowFolder.fold(result.rows(), court));
			}
			catch (SourceException e) {
				// 이 법원에서 실패 전까지 보낸 수는 fetchCourtRows가 이미 실었다. 여기서는 앞서 끝낸 법원들의 합계만 더한다.
				throw SourceException.attachRequestsMade(e, pagesRequested);
			}
		}
		return new FetchActiveItemsResult(items, pagesRequested);
	}

	@Override
	public FetchItemPhotosResult fetchItemPhotos(PhotoLookupRef ref) {
		int requestsMade = 0;
		try {
			if (photoCookie == null) {
				requestsMade += 1;
				photoCookie = bootstrapSession();
			}
			requestsMade += 1;
			String raw = detailRequest(ref, photoCookie);
			List<DetailPic> pics = DetailResponseParser.parse(raw);

			List<SourcePhoto> photos = new ArrayList<>();
			for (DetailPic pic : pics) {
				double seq = pic.seq() == null ? Double.NaN : pic.seq().toJsNumber();
				if (Double.isNaN(seq) || Double.isInfinite(seq) || pic.picFile() == null || pic.picFile().isEmpty()) {
					continue;
				}
				Long whole = JsValues.truncToLong(seq);
				if (whole != null) {
					photos.add(new SourcePhoto(whole, pic.picFile()));
				}
			}
			return new FetchItemPhotosResult(photos, requestsMade);
		}
		catch (SourceException e) {
			// 실패해도 실제로 몇 번 보냈는지는 남긴다(차단은 요청을 보냈기 때문에 발생한다).
			throw SourceException.attachRequestsMade(e, requestsMade);
		}
	}

	// ---------------------------------------------------------------- 요청

	private Map<String, String> postHeaders(String cookie) {
		Map<String, String> headers = new LinkedHashMap<>();
		headers.put("User-Agent", USER_AGENT);
		headers.put("Content-Type", "application/json;charset=UTF-8");
		headers.put("Accept", "application/json");
		headers.put("Referer", baseUrl + SESSION_BOOTSTRAP_PATH);
		headers.put("Origin", baseUrl);
		headers.put("X-Requested-With", "XMLHttpRequest");
		if (!cookie.isEmpty()) {
			headers.put("Cookie", cookie);
		}
		return headers;
	}

	/** {@code GET /pgj/index.on}로 세션 쿠키를 받는다. 쿠키를 못 받아도(빈 문자열) 경고만 남기고 계속한다. */
	private String bootstrapSession() {
		String url = baseUrl + SESSION_BOOTSTRAP_PATH;
		Map<String, String> headers = new LinkedHashMap<>();
		headers.put("User-Agent", USER_AGENT);
		headers.put("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8");
		CourtAuctionHttp.Response response = http.get(url, headers);
		if (!response.ok()) {
			throw new SourceRequestException("세션 초기화 요청이 실패했습니다 (HTTP " + response.status() + ")", url,
					response.status(), null);
		}
		String cookie = CourtAuctionHttp.readCookieHeader(response.setCookies());
		if (cookie.isEmpty()) {
			log.warn("[courtauction] 세션 쿠키를 받지 못했습니다 — 쿠키 없이 계속합니다");
		}
		return cookie;
	}

	private String detailRequest(PhotoLookupRef ref, String cookie) {
		String url = baseUrl + DETAIL_PATH;
		ObjectNode info = ResponseEnvelope.JSON.createObjectNode();
		info.put("csNo", ref.internalCaseNo());
		info.put("cortOfcCd", ref.courtCode());
		info.put("dspslGdsSeq", "");
		info.put("pgmId", "PGJ15BM01");
		ObjectNode body = ResponseEnvelope.JSON.createObjectNode();
		body.set("dma_srchGdsDtlSrch", info);

		CourtAuctionHttp.Response response = http.post(url, postHeaders(cookie), body.toString());
		if (!response.ok()) {
			throw new SourceRequestException("물건 상세 요청이 실패했습니다 (HTTP " + response.status() + ")", url,
					response.status(), null);
		}
		return response.body();
	}

	/** 검색 1회. 응답 3단 검사를 통과한 페이지만 돌려준다. */
	private SearchPage search(ObjectNode body, String cookie) {
		String url = baseUrl + SEARCH_PATH;
		CourtAuctionHttp.Response response = http.post(url, postHeaders(cookie), body.toString());
		if (!response.ok()) {
			throw new SourceRequestException("물건 검색 요청이 실패했습니다 (HTTP " + response.status() + ")", url,
					response.status(), null);
		}
		return SearchResponseParser.parse(response.body());
	}

	private record CourtRows(List<SearchRow> rows, int pagesRequested) {
	}

	/**
	 * 한 법원의 결과 행 전부와 실제로 요청한 페이지 수. {@code pagesRequested}는 매 페이지 요청을 보내기 직전에 갱신한다: 그 요청이 실패해도
	 * "시도했다"는 사실은 남아야 한다.
	 */
	private CourtRows fetchCourtRows(CourtRef court, String cookie) {
		String courtCode = RowFolder.resolveCourtCode(court, baseUrl + SEARCH_PATH);
		LocalDate today = LocalDate.now(clock);
		String bidBgngYmd = today.format(YMD);
		String bidEndYmd = today.plusDays(bidWindowDays).format(YMD);
		List<SearchRow> rows = new ArrayList<>();
		int pagesRequested = 0;

		try {
			// 첫 페이지: totalYn="Y"로 총건수까지 계산시킨다.
			pagesRequested = 1;
			SearchPage first = search(buildBody(courtCode, 1, bidBgngYmd, bidEndYmd, null, "Y", 0), cookie);
			rows.addAll(first.rows());

			// 페이지 수는 totalCnt(행 수)로 계산한다. groupTotalCount(물건 수)로 하면 일괄매각 때문에 뒷 페이지를 놓친다.
			long totalRows = RowFolder.toInt(first.totalCnt()) == null ? 0 : RowFolder.toInt(first.totalCnt());
			long pageCount = totalRows > 0 ? (totalRows + pageSize - 1) / pageSize : 1;
			log.info("[courtauction] {}({}) 매각기일 {}~{}: 총 {}행 / {}페이지 (page 1: {}행)", court.name(), courtCode, bidBgngYmd,
					bidEndYmd, totalRows, pageCount, first.rows().size());

			long lastPage = Math.min(pageCount, maxPages);
			if (pageCount > maxPages) {
				log.warn("[courtauction] 페이지 상한({})에 걸려 {}페이지 중 {}페이지까지만 수집합니다", maxPages, pageCount, lastPage);
			}

			for (int pageNo = 2; pageNo <= lastPage; pageNo++) {
				// 동시 요청 금지: 순차로, 사이에 대기를 둔다.
				sleeper.sleep(pageDelayMs);
				pagesRequested = pageNo;
				SearchPage page = search(buildBody(courtCode, pageNo, bidBgngYmd, bidEndYmd, pageNo - 1, "N", totalRows),
						cookie);
				rows.addAll(page.rows());
				log.info("[courtauction] {} page {}/{}: {}행 (누적 {})", court.name(), pageNo, lastPage, page.rows().size(),
						rows.size());
				// 총건수와 무관하게 빈 페이지가 나오면 더 볼 게 없다.
				if (page.rows().isEmpty()) {
					break;
				}
			}
			return new CourtRows(rows, pagesRequested);
		}
		catch (SourceException e) {
			throw SourceException.attachRequestsMade(e, pagesRequested);
		}
	}

	private ObjectNode buildBody(String courtCode, int pageNo, String bidBgngYmd, String bidEndYmd, Integer bfPageNo,
			String totalYn, long totalCnt) {
		ObjectNode pageInfo = ResponseEnvelope.JSON.createObjectNode();
		pageInfo.put("pageNo", pageNo);
		pageInfo.put("pageSize", pageSize);
		pageInfo.put("bfPageNo", bfPageNo != null ? bfPageNo : pageNo);
		pageInfo.put("startRowNo", "");
		pageInfo.put("totalCnt", totalCnt);
		pageInfo.put("totalYn", totalYn);
		pageInfo.put("groupTotalCount", "");

		ObjectNode search = ResponseEnvelope.JSON.createObjectNode();
		search.put("rletDspslSpcCondCd", "");
		search.put("bidDvsCd", BID_DIVISION_CODE);
		search.put("mvprpRletDvsCd", MOVABLE_REALTY_DIVISION_REALTY);
		search.put("cortAuctnSrchCondCd", SEARCH_COND_REALTY);
		search.put("cortOfcCd", courtCode);
		search.put("jdbnCd", "");
		search.put("lclDspslGdsLstUsgCd", "");
		search.put("mclDspslGdsLstUsgCd", "");
		search.put("sclDspslGdsLstUsgCd", "");
		search.put("cortStDvs", COURT_STANDARD_DIVISION);
		search.put("lafjOrderBy", "");
		search.put("pgmId", PROGRAM_ID);
		search.put("bidBgngYmd", bidBgngYmd);
		search.put("bidEndYmd", bidEndYmd);
		// 프론트는 안 보내는 값이지만 실제로 200을 받은 요청에 들어 있어 그대로 재현한다.
		search.set("srchInfo", ResponseEnvelope.JSON.createObjectNode());

		ObjectNode body = ResponseEnvelope.JSON.createObjectNode();
		body.set("dma_pageInfo", pageInfo);
		body.set("dma_srchGdsDtlSrchInfo", search);
		return body;
	}

}
