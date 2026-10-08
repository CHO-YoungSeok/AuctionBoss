package com.auctionboss.collect.source.courtauction;

/**
 * 어댑터 옵션. 기본값은 TS 어댑터와 같다.
 *
 * @param baseUrl 소스 주소
 * @param pageSize 한 요청의 행 수(서버 상한 40을 넘으면 40으로 낮춘다)
 * @param pageDelayMs 페이지·법원 사이 대기
 * @param bidWindowDays 매각기일 창 길이(오늘 ~ +일)
 * @param maxPages 법원당 페이지 상한
 */
public record CourtAuctionOptions(String baseUrl, int pageSize, long pageDelayMs, int bidWindowDays, int maxPages) {

	public static final String BASE_URL = "https://www.courtauction.go.kr";

	/** 서버가 받아 주는 pageSize 상한. 100을 보내면 HTTP 400이 온다(실측). */
	public static final int MAX_PAGE_SIZE = 40;

	public static final long DEFAULT_PAGE_DELAY_MS = 5_000;

	public static final int DEFAULT_BID_WINDOW_DAYS = 60;

	public static final int DEFAULT_MAX_PAGES = 50;

	public static CourtAuctionOptions defaults() {
		return new CourtAuctionOptions(BASE_URL, MAX_PAGE_SIZE, DEFAULT_PAGE_DELAY_MS, DEFAULT_BID_WINDOW_DAYS,
				DEFAULT_MAX_PAGES);
	}

	public CourtAuctionOptions withBaseUrl(String value) {
		return new CourtAuctionOptions(value, pageSize, pageDelayMs, bidWindowDays, maxPages);
	}

	public CourtAuctionOptions withPageSize(int value) {
		return new CourtAuctionOptions(baseUrl, value, pageDelayMs, bidWindowDays, maxPages);
	}

	public CourtAuctionOptions withPageDelayMs(long value) {
		return new CourtAuctionOptions(baseUrl, pageSize, value, bidWindowDays, maxPages);
	}

	public CourtAuctionOptions withMaxPages(int value) {
		return new CourtAuctionOptions(baseUrl, pageSize, pageDelayMs, bidWindowDays, value);
	}

}
