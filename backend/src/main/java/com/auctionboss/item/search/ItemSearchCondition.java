package com.auctionboss.item.search;

import java.time.LocalDate;
import java.util.List;

/**
 * 파서가 검증을 마친 목록 검색 조건. 없는 조건은 null(목록은 빈 리스트 대신 null)이다.
 * 원본 {@code ItemQuery}와 같은 의미다. 재분석 간격은 요청이 아니라 설정에서 오므로 여기 없다.
 *
 * @param page 1부터
 * @param pageSize 1~200
 * @param analyzed false=분석 없는 물건만, true=있는 물건만, null=전체
 * @param needsAnalysis true=재분석 대상만 (이때 promptVersion 필수)
 * @param usageTypes 용도 토큰, 하나라도 일치(OR)
 * @param minPrice 최저매각가격 하한(원, 억/만원 환산 후)
 * @param keyword 주소·사건번호·건물명 부분 일치
 * @param excludePast true=오늘(한국 시간) 이후 매각기일만
 * @param bookmarked true=관심만, false=관심 제외, null=전체
 * @param minDiscountRate 0~100
 * @param hasPhotos true=수집된 사진 있음, false=없음, null=전체
 * @param sort 기본 AUCTION_DATE
 * @param direction 기본 ASC
 */
public record ItemSearchCondition(long page, int pageSize, Boolean analyzed, boolean needsAnalysis,
		String promptVersion, List<String> usageTypes, Long minPrice, Long maxPrice, Integer minFailedBidCount,
		String keyword, List<String> sidoValues, List<String> sigunguValues, LocalDate auctionDateFrom,
		LocalDate auctionDateTo, boolean excludePast, Boolean bookmarked, String court, Integer minDiscountRate,
		Boolean hasPhotos, SortKey sort, SortDirection direction) {

	public static final int DEFAULT_PAGE_SIZE = 20;

	public static final int MAX_PAGE_SIZE = 200;

	public ItemSearchCondition {
		if (needsAnalysis && promptVersion == null) {
			throw new IllegalArgumentException("needsAnalysis=true이면 promptVersion이 필요합니다");
		}
		sort = sort == null ? SortKey.AUCTION_DATE : sort;
		direction = direction == null ? SortDirection.ASC : direction;
	}

	/** 필터 없는 기본 조건(page 1, pageSize 20). */
	public static ItemSearchCondition defaults() {
		return new ItemSearchCondition(1L, DEFAULT_PAGE_SIZE, null, false, null, null, null, null, null, null, null,
				null, null, null, false, null, null, null, null, null, null);
	}

}
