package com.auctionboss.item.search;

import java.time.LocalDate;
import java.util.List;

/** 테스트용 ItemSearchCondition 빌더. */
final class ConditionBuilder {

	private long page = 1;

	private int pageSize = 20;

	private Boolean analyzed;

	private String needsAnalysis;

	private List<String> usage;

	private Long minPrice;

	private Long maxPrice;

	private Integer minFailed;

	private String keyword;

	private List<String> sido;

	private List<String> sigungu;

	private LocalDate dateFrom;

	private LocalDate dateTo;

	private boolean excludePast;

	private Boolean bookmarked;

	private String court;

	private Integer minDiscountRate;

	private Boolean hasPhotos;

	private SortKey sort;

	private SortDirection dir;

	ConditionBuilder page(long v) {
		page = v;
		return this;
	}

	ConditionBuilder pageSize(int v) {
		pageSize = v;
		return this;
	}

	ConditionBuilder analyzed(boolean v) {
		analyzed = v;
		return this;
	}

	ConditionBuilder needsAnalysis(String promptVersion) {
		needsAnalysis = promptVersion;
		return this;
	}

	ConditionBuilder usage(String... v) {
		usage = List.of(v);
		return this;
	}

	ConditionBuilder minPrice(long v) {
		minPrice = v;
		return this;
	}

	ConditionBuilder maxPrice(long v) {
		maxPrice = v;
		return this;
	}

	ConditionBuilder minFailed(int v) {
		minFailed = v;
		return this;
	}

	ConditionBuilder keyword(String v) {
		keyword = v;
		return this;
	}

	ConditionBuilder sido(String... v) {
		sido = List.of(v);
		return this;
	}

	ConditionBuilder sigungu(String... v) {
		sigungu = List.of(v);
		return this;
	}

	ConditionBuilder dateFrom(String v) {
		dateFrom = LocalDate.parse(v);
		return this;
	}

	ConditionBuilder dateTo(String v) {
		dateTo = LocalDate.parse(v);
		return this;
	}

	ConditionBuilder excludePast() {
		excludePast = true;
		return this;
	}

	ConditionBuilder bookmarked(boolean v) {
		bookmarked = v;
		return this;
	}

	ConditionBuilder court(String v) {
		court = v;
		return this;
	}

	ConditionBuilder minDiscountRate(int v) {
		minDiscountRate = v;
		return this;
	}

	ConditionBuilder hasPhotos(boolean v) {
		hasPhotos = v;
		return this;
	}

	ConditionBuilder sort(SortKey v) {
		sort = v;
		return this;
	}

	ConditionBuilder dir(SortDirection v) {
		dir = v;
		return this;
	}

	ItemSearchCondition build() {
		return new ItemSearchCondition(page, pageSize, analyzed, needsAnalysis != null, needsAnalysis, usage,
				minPrice, maxPrice, minFailed, keyword, sido, sigungu, dateFrom, dateTo, excludePast, bookmarked,
				court, minDiscountRate, hasPhotos, sort, dir);
	}

}
