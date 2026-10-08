package com.auctionboss.item.search;

import static org.assertj.core.api.Assertions.assertThat;

import java.time.LocalDate;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.IntStream;

import com.auctionboss.common.error.FieldIssue;
import org.junit.jupiter.api.Test;

/** 원본 item-query.test.ts의 strict 파서(parseItemQuery) 사례를 옮긴 것. field와 해석값이 같아야 한다. */
class ItemQueryParserTest {

	/** 파라미터 목록: p("page", "3", "usage", "a", "usage", "b")처럼 같은 이름을 반복할 수 있다. */
	private static Map<String, List<String>> p(String... kv) {
		Map<String, List<String>> map = new LinkedHashMap<>();
		for (int i = 0; i < kv.length; i += 2) {
			map.computeIfAbsent(kv[i], k -> new ArrayList<>()).add(kv[i + 1]);
		}
		return map;
	}

	private static ItemSearchCondition ok(Map<String, List<String>> params) {
		ParseResult r = ItemQueryParser.parse(params);
		if (r instanceof ParseResult.Failure f) {
			throw new AssertionError("파싱이 실패했다: " + f.issues());
		}
		return ((ParseResult.Success) r).condition();
	}

	private static List<FieldIssue> fail(Map<String, List<String>> params) {
		ParseResult r = ItemQueryParser.parse(params);
		if (r instanceof ParseResult.Success s) {
			throw new AssertionError("실패를 기대했는데 성공했다: " + s.condition());
		}
		return ((ParseResult.Failure) r).issues();
	}

	private static List<String> fields(Map<String, List<String>> params) {
		return fail(params).stream().map(FieldIssue::field).toList();
	}

	private static List<String> sortedFields(Map<String, List<String>> params) {
		return fail(params).stream().map(FieldIssue::field).sorted().toList();
	}

	@Test
	void noParamsGiveDefaults() {
		assertThat(ok(p())).isEqualTo(ItemSearchCondition.defaults());
		ItemSearchCondition c = ok(p());
		assertThat(c.page()).isEqualTo(1);
		assertThat(c.pageSize()).isEqualTo(20);
		assertThat(c.sort()).isEqualTo(SortKey.AUCTION_DATE);
		assertThat(c.direction()).isEqualTo(SortDirection.ASC);
		assertThat(c.needsAnalysis()).isFalse();
		assertThat(c.excludePast()).isFalse();
	}

	@Test
	void parsesBasicQuery() {
		ItemSearchCondition c = ok(p("page", "3", "pageSize", "50", "q", "강남", "sort", "bidRatio", "dir", "desc"));

		assertThat(c.page()).isEqualTo(3);
		assertThat(c.pageSize()).isEqualTo(50);
		assertThat(c.keyword()).isEqualTo("강남");
		assertThat(c.sort()).isEqualTo(SortKey.BID_RATIO);
		assertThat(c.direction()).isEqualTo(SortDirection.DESC);
	}

	@Test
	void usageIsRepeatedParamAndCommasAreNotSplit() {
		assertThat(ok(p("usage", "아파트", "usage", "다세대")).usageTypes()).containsExactly("아파트", "다세대");
		assertThat(ok(p("usage", "아파트")).usageTypes()).containsExactly("아파트");
		assertThat(ok(p("usage", "상가,오피스텔,근린시설", "usage", "아파트")).usageTypes())
				.containsExactly("상가,오피스텔,근린시설", "아파트");
	}

	@Test
	void priceRangeMayBeOneSided() {
		ItemSearchCondition min = ok(p("minPrice", "100000000"));
		assertThat(min.minPrice()).isEqualTo(100_000_000L);
		assertThat(min.maxPrice()).isNull();
		assertThat(ok(p("maxPrice", "500000000")).maxPrice()).isEqualTo(500_000_000L);
		ItemSearchCondition both = ok(p("minPrice", "100", "maxPrice", "500"));
		assertThat(both.minPrice()).isEqualTo(100L);
		assertThat(both.maxPrice()).isEqualTo(500L);
	}

	@Test
	void recognizedParamsWithEmptyValuesAreRejected() {
		Map<String, List<String>> params = p("page", "", "pageSize", "", "analyzed", "", "usage", "", "minPrice", "",
				"maxPrice", "", "minFailed", "", "q", "", "sort", "", "dir", "");

		assertThat(sortedFields(params)).containsExactly("analyzed", "dir", "maxPrice", "minFailed", "minPrice",
				"page", "pageSize", "q", "sort", "usage");
		assertThat(fields(p("analyzed", " "))).containsExactly("analyzed");
		assertThat(fields(p("q", "   "))).containsExactly("q");
		assertThat(fields(p("promptVersion", ""))).containsExactly("promptVersion");
	}

	@Test
	void emptyValueRejectsOnlyThatParamAndKeepsValidatingTheRest() {
		assertThat(sortedFields(p("minPrice", "", "maxPrice", "500", "usage", "", "usage", "아파트")))
				.containsExactly("minPrice", "usage");
	}

	@Test
	void tooManyUsageValuesAreRejected() {
		List<String> tooMany = IntStream.rangeClosed(0, 50).mapToObj(i -> "용도" + i).toList();
		Map<String, List<String>> over = new LinkedHashMap<>();
		over.put("usage", tooMany);
		assertThat(fields(over)).containsExactly("usage");

		Map<String, List<String>> exact = new LinkedHashMap<>();
		exact.put("usage", tooMany.subList(0, 50));
		assertThat(ok(exact).usageTypes()).hasSize(50);
	}

	@Test
	void keywordIsTrimmedButInnerWhitespaceKept() {
		assertThat(ok(p("q", "  강남구 역삼동  ")).keyword()).isEqualTo("강남구 역삼동");
	}

	@Test
	void trimMatchesJsTrimForUnicodeSpaces() {
		assertThat(ok(p("q", " 강남﻿")).keyword()).isEqualTo("강남");
		assertThat(fields(p("q", " "))).containsExactly("q");
	}

	@Test
	void analyzedAcceptsOnlyTrueOrFalse() {
		assertThat(ok(p("analyzed", "false")).analyzed()).isFalse();
		assertThat(ok(p("analyzed", "true")).analyzed()).isTrue();
		assertThat(fields(p("analyzed", "1"))).containsExactly("analyzed");
		assertThat(fields(p("analyzed", "TRUE"))).containsExactly("analyzed");
		assertThat(ok(p()).analyzed()).isNull();
	}

	@Test
	void courtMinDiscountRateAndHasPhotos() {
		ItemSearchCondition c = ok(p("court", "서울중앙", "minDiscountRate", "30", "hasPhotos", "true"));
		assertThat(c.court()).isEqualTo("서울중앙");
		assertThat(c.minDiscountRate()).isEqualTo(30);
		assertThat(c.hasPhotos()).isTrue();
		assertThat(ok(p("hasPhotos", "false")).hasPhotos()).isFalse();

		assertThat(fields(p("minDiscountRate", "-1"))).containsExactly("minDiscountRate");
		assertThat(fields(p("minDiscountRate", "101"))).containsExactly("minDiscountRate");
		assertThat(ok(p("minDiscountRate", "0")).minDiscountRate()).isZero();
		assertThat(ok(p("minDiscountRate", "100")).minDiscountRate()).isEqualTo(100);
		assertThat(fields(p("hasPhotos", "yes"))).containsExactly("hasPhotos");
	}

	@Test
	void analyzedFalseWithPageSizeStillWorks() {
		// 분석 워커의 기존 계약(analyzed=false&pageSize=N).
		ItemSearchCondition c = ok(p("analyzed", "false", "pageSize", "5"));
		assertThat(c.analyzed()).isFalse();
		assertThat(c.pageSize()).isEqualTo(5);
		assertThat(c.needsAnalysis()).isFalse();
	}

	@Test
	void needsAnalysisRequiresPromptVersion() {
		ItemSearchCondition c = ok(p("needsAnalysis", "true", "promptVersion", "v1"));
		assertThat(c.needsAnalysis()).isTrue();
		assertThat(c.promptVersion()).isEqualTo("v1");

		assertThat(fields(p("needsAnalysis", "true"))).containsExactly("needsAnalysis");
		assertThat(fields(p("needsAnalysis", "false"))).containsExactly("needsAnalysis");
		assertThat(fields(p("needsAnalysis", "1"))).containsExactly("needsAnalysis");
	}

	@Test
	void promptVersionAloneIsNotAnError() {
		ItemSearchCondition c = ok(p("promptVersion", "v1"));
		assertThat(c.promptVersion()).isEqualTo("v1");
		assertThat(c.needsAnalysis()).isFalse();
	}

	@Test
	void invalidSortAndDirAreRejectedWithMessageNamingTheParam() {
		List<FieldIssue> issues = fail(p("sort", "appraisalPrice"));
		assertThat(issues).extracting(FieldIssue::field).containsExactly("sort");
		assertThat(issues.get(0).message()).contains("sort").contains("bidRatio");
		assertThat(fields(p("dir", "DESC"))).containsExactly("dir");
	}

	@Test
	void allFiveSortKeysAndBothDirectionsPass() {
		for (String s : List.of("auctionDate", "minBidPrice", "bidRatio", "failedBidCount", "pricePerArea")) {
			assertThat(ok(p("sort", s)).sort().param()).isEqualTo(s);
		}
		assertThat(ok(p("dir", "asc")).direction()).isEqualTo(SortDirection.ASC);
		assertThat(ok(p("dir", "desc")).direction()).isEqualTo(SortDirection.DESC);
	}

	@Test
	void rejectsNonNumericNegativeAndFractionalValues() {
		assertThat(fields(p("minPrice", "abc"))).containsExactly("minPrice");
		assertThat(fields(p("minPrice", "-1"))).containsExactly("minPrice");
		assertThat(fields(p("maxPrice", "1.5"))).containsExactly("maxPrice");
		assertThat(fields(p("minFailed", "세 번"))).containsExactly("minFailed");
		assertThat(fields(p("page", "0"))).containsExactly("page");
		assertThat(fields(p("pageSize", "0"))).containsExactly("pageSize");
		assertThat(fields(p("pageSize", "201"))).containsExactly("pageSize");
		assertThat(ok(p("pageSize", "200")).pageSize()).isEqualTo(200);
		assertThat(fields(p("page", "9007199254740992"))).containsExactly("page");
		assertThat(ok(p("page", "9007199254740991")).page()).isEqualTo(9_007_199_254_740_991L);
	}

	@Test
	void unrelatedFieldLevelErrorsAreAllReported() {
		assertThat(sortedFields(p("sort", "nope", "minPrice", "abc"))).containsExactly("minPrice", "sort");
	}

	@Test
	void minPriceGreaterThanMaxPriceNamesBothAndEqualPasses() {
		List<FieldIssue> issues = fail(p("minPrice", "500", "maxPrice", "100"));
		assertThat(issues).extracting(FieldIssue::field).containsExactly("minPrice", "maxPrice");
		assertThat(issues.get(0).message()).contains("maxPrice");
		ItemSearchCondition eq = ok(p("minPrice", "100", "maxPrice", "100"));
		assertThat(eq.minPrice()).isEqualTo(100L);
		assertThat(eq.maxPrice()).isEqualTo(100L);
	}

	@Test
	void fieldLevelErrorSkipsCrossValidation() {
		assertThat(fields(p("sort", "nope", "minPrice", "500", "maxPrice", "100"))).containsExactly("sort");
		assertThat(fields(p("minPrice", "abc", "maxPrice", "100"))).containsExactly("minPrice");
	}

	@Test
	void scalarParamRepeatedUsesTheFirstValue() {
		assertThat(ok(p("page", "2", "page", "7")).page()).isEqualTo(2);
	}

	@Test
	void unknownParamsAreIgnored() {
		assertThat(ok(p("utm_source", "kakao", "nope", "x"))).isEqualTo(ItemSearchCondition.defaults());
	}

	@Test
	void parsesFullCombination() {
		ItemSearchCondition c = ok(p("usage", "아파트", "usage", "다세대", "minPrice", "100000000", "maxPrice", "500000000",
				"minFailed", "3", "q", "강남", "sort", "bidRatio", "dir", "asc", "page", "2", "pageSize", "50",
				"analyzed", "false"));

		assertThat(c.usageTypes()).containsExactly("아파트", "다세대");
		assertThat(c.minPrice()).isEqualTo(100_000_000L);
		assertThat(c.maxPrice()).isEqualTo(500_000_000L);
		assertThat(c.minFailedBidCount()).isEqualTo(3);
		assertThat(c.keyword()).isEqualTo("강남");
		assertThat(c.sort()).isEqualTo(SortKey.BID_RATIO);
		assertThat(c.direction()).isEqualTo(SortDirection.ASC);
		assertThat(c.page()).isEqualTo(2);
		assertThat(c.pageSize()).isEqualTo(50);
		assertThat(c.analyzed()).isFalse();
	}

	// ---- 지역 ----

	@Test
	void regionParamsAreRepeatedParams() {
		ItemSearchCondition c = ok(p("sido", "서울특별시", "sido", "경기도", "sigungu", "관악구"));
		assertThat(c.sidoValues()).containsExactly("서울특별시", "경기도");
		assertThat(c.sigunguValues()).containsExactly("관악구");
	}

	@Test
	void regionEmptyValuesAndLimitFollowUsageRules() {
		assertThat(fields(p("sido", ""))).containsExactly("sido");
		Map<String, List<String>> tooMany = new LinkedHashMap<>();
		tooMany.put("sido", IntStream.range(0, 51).mapToObj(i -> "지역" + i).toList());
		assertThat(fields(tooMany)).containsExactly("sido");
		Map<String, List<String>> sigungu = new LinkedHashMap<>();
		sigungu.put("sigungu", IntStream.range(0, 51).mapToObj(i -> "구" + i).toList());
		assertThat(fields(sigungu)).containsExactly("sigungu");
	}

	// ---- 억/만원 ----

	@Test
	void eokAndManAreCombinedToWon() {
		ItemSearchCondition c = ok(p("minEok", "1", "minMan", "2000", "maxEok", "3"));
		assertThat(c.minPrice()).isEqualTo(120_000_000L);
		assertThat(c.maxPrice()).isEqualTo(300_000_000L);
		assertThat(ok(p("minMan", "500")).minPrice()).isEqualTo(5_000_000L);
		assertThat(ok(p("minEok", "0", "minMan", "0")).minPrice()).isZero();
	}

	@Test
	void rawWonParamBeatsEokAndMan() {
		assertThat(ok(p("minPrice", "1", "minEok", "5", "minMan", "5000")).minPrice()).isEqualTo(1L);
	}

	@Test
	void reversedEokManRangeNamesTheActualParams() {
		assertThat(sortedFields(p("minEok", "5", "maxEok", "1"))).containsExactly("maxEok", "minEok");
		assertThat(sortedFields(p("minPrice", "500000000", "maxEok", "1"))).containsExactly("maxEok", "minPrice");
	}

	@Test
	void rawOnlyReversedRangeIsReportedOnce() {
		assertThat(fail(p("minPrice", "500", "maxPrice", "100"))).hasSize(2);
	}

	@Test
	void eokTimesWonBeyondSafeIntegerIsRejected() {
		// 9007199254740991 억은 원으로 바꾸면 JS 안전 정수 범위를 넘는다. 각 값은 단독으로는 유효하다.
		assertThat(fields(p("minEok", "9007199254740991"))).containsExactly("minEok");
		assertThat(ok(p("minEok", "90071992")).minPrice()).isEqualTo(9_007_199_200_000_000L);
	}

	// ---- 날짜 ----

	@Test
	void dateRange() {
		ItemSearchCondition c = ok(p("dateFrom", "2026-01-01", "dateTo", "2026-12-31"));
		assertThat(c.auctionDateFrom()).isEqualTo(LocalDate.of(2026, 1, 1));
		assertThat(c.auctionDateTo()).isEqualTo(LocalDate.of(2026, 12, 31));
		assertThat(fields(p("dateFrom", "2026/01/01"))).containsExactly("dateFrom");
		assertThat(fields(p("dateTo", "20260101"))).containsExactly("dateTo");
		assertThat(fields(p("dateFrom", "2026-12-31", "dateTo", "2026-01-01"))).containsExactly("dateFrom", "dateTo");
		ItemSearchCondition same = ok(p("dateFrom", "2026-01-01", "dateTo", "2026-01-01"));
		assertThat(same.auctionDateFrom()).isEqualTo(same.auctionDateTo());
	}

	@Test
	void nonexistentCalendarDateIsRejected() {
		// 의도적 차이: 원본은 모양만 검사해 통과시켰지만 MySQL DATE 비교가 오류를 내므로 400으로 거른다.
		assertThat(fields(p("dateFrom", "2026-02-30"))).containsExactly("dateFrom");
		assertThat(fields(p("dateTo", "2026-13-01"))).containsExactly("dateTo");
	}

	@Test
	void excludePastIsOptInTrueOnly() {
		assertThat(ok(p()).excludePast()).isFalse();
		assertThat(ok(p("dateFrom", "2026-01-01")).excludePast()).isFalse();
		assertThat(ok(p("excludePast", "true")).excludePast()).isTrue();
		assertThat(fields(p("excludePast", "false"))).containsExactly("excludePast");
	}

	@Test
	void bookmarkedAcceptsTrueAndFalse() {
		assertThat(ok(p("bookmarked", "true")).bookmarked()).isTrue();
		assertThat(ok(p("bookmarked", "false")).bookmarked()).isFalse();
		assertThat(ok(p()).bookmarked()).isNull();
		assertThat(fields(p("bookmarked", "1"))).containsExactly("bookmarked");
	}

	@Test
	void nullMapValuesAreTreatedAsEmpty() {
		Map<String, List<String>> params = new LinkedHashMap<>();
		List<String> nullValue = new ArrayList<>();
		nullValue.add(null);
		params.put("q", nullValue);
		assertThat(fields(params)).containsExactly("q");
	}

}
