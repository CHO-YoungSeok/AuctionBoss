package com.auctionboss.item.search;

import static com.auctionboss.support.TestData.T0;
import static com.auctionboss.support.TestData.item;
import static org.assertj.core.api.Assertions.assertThat;

import java.time.Instant;
import java.time.LocalDate;
import java.util.List;

import com.auctionboss.analysis.Analysis;
import com.auctionboss.analysis.AnalysisRepository;
import com.auctionboss.history.ChangeKind;
import com.auctionboss.history.ItemChange;
import com.auctionboss.history.ItemChangeRepository;
import com.auctionboss.item.AuctionSchedule;
import com.auctionboss.item.Item;
import com.auctionboss.item.ItemRepository;
import com.auctionboss.item.Location;
import com.auctionboss.item.PhotoInfo;
import com.auctionboss.item.dto.ItemResponse;
import com.auctionboss.photo.PhotoStatus;
import com.auctionboss.support.AbstractMySqlTest;
import com.auctionboss.support.FixedClockConfig;
import com.auctionboss.support.MutableClock;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.context.annotation.Import;
import org.springframework.test.context.TestPropertySource;

/** 5.3, 5.4: 목록 검색(필터, 정렬, 페이지, 서브쿼리 컬럼)과 재분석 대상 조회. 시각은 고정 Clock이다. */
@Import(FixedClockConfig.class)
@TestPropertySource(properties = "auctionboss.analysis.reanalysis-cooldown-hours=24")
class ItemSearchRepositoryTest extends AbstractMySqlTest {

	@Autowired
	ItemRepository items;
	@Autowired
	AnalysisRepository analyses;
	@Autowired
	ItemChangeRepository changes;
	@Autowired
	ItemSearchRepository search;
	@Autowired
	MutableClock clock;

	private int seq = 0;

	@BeforeEach
	void resetClock() {
		clock.set(FixedClockConfig.DEFAULT_NOW);
	}

	private static Instant at(String iso) {
		return Instant.parse(iso);
	}

	private Item.Builder base() {
		return item("2026타경" + (++seq), "1");
	}

	private Item save(Item.Builder b) {
		return items.save(b.build());
	}

	private static Location loc(String address, String sido, String sigungu, String buildingName) {
		return new Location(address, sido, sigungu, null, null, buildingName, null, null, null, null);
	}

	private static AuctionSchedule on(String date) {
		return new AuctionSchedule(date == null ? null : LocalDate.parse(date), null, null, null, null);
	}

	private static ConditionBuilder cond() {
		return new ConditionBuilder();
	}

	private List<Long> ids(ItemSearchCondition c) {
		return search.search(c).items().stream().map(ItemResponse::id).toList();
	}

	private ItemPage page(ItemSearchCondition c) {
		return search.search(c);
	}

	// ---- 필터 ----

	@Test
	void noFilterReturnsEverythingWithDefaultsAndTotal() {
		Item a = save(base().schedule(on("2026-10-02")));
		Item b = save(base().schedule(on("2026-10-01")));

		ItemPage result = page(ItemSearchCondition.defaults());

		assertThat(result.total()).isEqualTo(2);
		assertThat(result.page()).isEqualTo(1);
		assertThat(result.pageSize()).isEqualTo(20);
		assertThat(result.items()).extracting(ItemResponse::id).containsExactly(b.getId(), a.getId());
	}

	@Test
	void priceAndFailedCountBoundsAreInclusiveAndExcludeNull() {
		Item low = save(base().minBidPrice(100L).failedBidCount(1));
		Item mid = save(base().minBidPrice(200L).failedBidCount(2));
		Item high = save(base().minBidPrice(300L).failedBidCount(3));
		Item unknown = save(base());

		assertThat(ids(cond().minPrice(200L).build())).containsExactly(mid.getId(), high.getId());
		assertThat(ids(cond().maxPrice(200L).build())).containsExactly(low.getId(), mid.getId());
		assertThat(ids(cond().minPrice(100L).maxPrice(200L).build())).containsExactly(low.getId(), mid.getId());
		assertThat(ids(cond().minFailed(2).build())).containsExactly(mid.getId(), high.getId());
		assertThat(ids(cond().build())).contains(unknown.getId());
	}

	@Test
	void hugeAmountsAreNotTruncated() {
		Item big = save(base().minBidPrice(51_005_255_120L).appraisalPrice(51_005_255_120L));
		save(base().minBidPrice(100L));

		assertThat(ids(cond().minPrice(51_005_255_000L).build())).containsExactly(big.getId());
		assertThat(page(cond().minPrice(51_005_255_000L).build()).items().get(0).minBidPrice())
				.isEqualTo(51_005_255_120L);
	}

	@Test
	void keywordMatchesAddressCaseNoOrBuildingNameCaseInsensitively() {
		Item byAddress = save(base().location(loc("서울 강남구 역삼동", null, null, null)));
		Item byCase = save(item("2025타경777", "1").location(loc("부산", null, null, null)));
		Item byBuilding = save(base().location(loc("대구", null, null, "역삼ABC타워")));
		save(base().location(loc("광주", null, null, "무관")));
		save(base());

		assertThat(ids(cond().keyword("역삼").build())).containsExactly(byAddress.getId(), byBuilding.getId());
		assertThat(ids(cond().keyword("타경777").build())).containsExactly(byCase.getId());
		assertThat(ids(cond().keyword("abc").build())).containsExactly(byBuilding.getId());
	}

	@Test
	void likeWildcardsAndBackslashAreMatchedLiterally() {
		Item percent = save(base().location(loc("서울 100% 지분", null, null, null)));
		Item underscore = save(base().location(loc("서울 A_B 동", null, null, null)));
		Item backslash = save(base().location(loc("서울 C\\D 동", null, null, null)));
		Item plain = save(base().location(loc("서울 AxB 동 100원", null, null, null)));

		assertThat(ids(cond().keyword("%").build())).containsExactly(percent.getId());
		assertThat(ids(cond().keyword("_").build())).containsExactly(underscore.getId());
		assertThat(ids(cond().keyword("A_B").build())).containsExactly(underscore.getId());
		assertThat(ids(cond().keyword("\\").build())).containsExactly(backslash.getId());
		assertThat(ids(cond().keyword("C\\D").build())).containsExactly(backslash.getId());
		assertThat(ids(cond().keyword("AxB").build())).containsExactly(plain.getId());
	}

	@Test
	void usageMatchesCommaSeparatedTokensExactlyAndOrCombines() {
		Item compound = save(base().usageType("상가,오피스텔,근린시설"));
		Item single = save(base().usageType("오피스텔"));
		Item similar = save(base().usageType("오피스텔형"));
		Item apt = save(base().usageType("아파트"));
		save(base());

		assertThat(ids(cond().usage("오피스텔").build())).containsExactly(compound.getId(), single.getId());
		assertThat(ids(cond().usage("근린시설").build())).containsExactly(compound.getId());
		// 복합 문자열 전체도 앞뒤 콤마를 붙인 연속 구간으로 매칭된다(원본과 같다).
		assertThat(ids(cond().usage("상가,오피스텔,근린시설").build())).containsExactly(compound.getId());
		assertThat(ids(cond().usage("오피스텔", "아파트").build()))
				.containsExactly(compound.getId(), single.getId(), apt.getId());
		assertThat(ids(cond().usage("오피스텔형").build())).containsExactly(similar.getId());
		assertThat(ids(cond().usage("%").build())).isEmpty();
	}

	@Test
	void usageWildcardCharactersAreLiteral() {
		Item odd = save(base().usageType("A_B,C%D"));
		save(base().usageType("AxB"));

		assertThat(ids(cond().usage("A_B").build())).containsExactly(odd.getId());
		assertThat(ids(cond().usage("C%D").build())).containsExactly(odd.getId());
		assertThat(ids(cond().usage("A%").build())).isEmpty();
	}

	@Test
	void regionAndCourtFiltersMatchExactly() {
		Item seoulGangnam = save(base().location(loc(null, "서울특별시", "강남구", null)));
		Item seoulSongpa = save(base().location(loc(null, "서울특별시", "송파구", null)));
		Item busan = save(base().location(loc(null, "부산광역시", "해운대구", null)));
		Item otherCourt = items.save(Item.builder("수원지방법원", "2026타경999", "1", T0, T0).build());

		assertThat(ids(cond().sido("서울특별시").build())).containsExactly(seoulGangnam.getId(), seoulSongpa.getId());
		assertThat(ids(cond().sido("서울특별시", "부산광역시").build())).containsExactly(seoulGangnam.getId(),
				seoulSongpa.getId(), busan.getId());
		assertThat(ids(cond().sigungu("송파구").build())).containsExactly(seoulSongpa.getId());
		assertThat(ids(cond().sido("서울").build())).isEmpty();
		assertThat(ids(cond().court("수원지방법원").build())).containsExactly(otherCourt.getId());
	}

	@Test
	void auctionDateRangeIsInclusiveAndExcludesNull() {
		Item d1 = save(base().schedule(on("2026-10-01")));
		Item d2 = save(base().schedule(on("2026-10-05")));
		Item d3 = save(base().schedule(on("2026-10-10")));
		save(base());

		assertThat(ids(cond().dateFrom("2026-10-05").build())).containsExactly(d2.getId(), d3.getId());
		assertThat(ids(cond().dateTo("2026-10-05").build())).containsExactly(d1.getId(), d2.getId());
		assertThat(ids(cond().dateFrom("2026-10-05").dateTo("2026-10-05").build())).containsExactly(d2.getId());
	}

	@Test
	void excludePastUsesTodayInSeoulFromTheInjectedClock() {
		// 2026-10-08T16:00Z = 서울 2026-10-09 01:00. UTC 날짜(10-08)가 아니라 서울 날짜(10-09)가 기준이다.
		clock.set(at("2026-10-08T16:00:00Z"));
		Item yesterdaySeoul = save(base().schedule(on("2026-10-08")));
		Item todaySeoul = save(base().schedule(on("2026-10-09")));
		Item future = save(base().schedule(on("2026-10-20")));
		Item noDate = save(base());

		assertThat(ids(cond().excludePast().build())).containsExactly(todaySeoul.getId(), future.getId());
		assertThat(ids(cond().build())).contains(yesterdaySeoul.getId(), noDate.getId());

		// 한국 시간 자정 직전(UTC 14:59)은 아직 전날이다.
		clock.set(at("2026-10-08T14:59:59Z"));
		assertThat(ids(cond().excludePast().build())).containsExactly(yesterdaySeoul.getId(), todaySeoul.getId(),
				future.getId());
	}

	@Test
	void minDiscountRateUsesRealDivisionAndExcludesZeroAppraisalAndNullPrice() {
		Item d30 = save(base().appraisalPrice(1000L).minBidPrice(700L));
		Item d29 = save(base().appraisalPrice(1000L).minBidPrice(701L));
		Item d51 = save(base().appraisalPrice(1000L).minBidPrice(490L));
		save(base().appraisalPrice(0L).minBidPrice(0L));
		save(base().appraisalPrice(1000L));
		save(base().minBidPrice(100L));

		assertThat(ids(cond().minDiscountRate(30).build())).containsExactly(d30.getId(), d51.getId());
		assertThat(ids(cond().minDiscountRate(0).build())).containsExactly(d30.getId(), d29.getId(), d51.getId());
		assertThat(ids(cond().minDiscountRate(52).build())).isEmpty();
		assertThat(ids(cond().minDiscountRate(51).build())).containsExactly(d51.getId());
		assertThat(ids(cond().minDiscountRate(100).build())).isEmpty();
	}

	@Test
	void hasPhotosTrueMeansCollectedOnlyAndFalseIncludesNullAndOtherStatuses() {
		Item collected = save(base().photoInfo(new PhotoInfo(PhotoStatus.COLLECTED, 3, T0)));
		Item empty = save(base().photoInfo(new PhotoInfo(PhotoStatus.EMPTY, 0, T0)));
		Item failed = save(base().photoInfo(new PhotoInfo(PhotoStatus.FAILED, null, null)));
		Item none = save(base());

		assertThat(ids(cond().hasPhotos(true).build())).containsExactly(collected.getId());
		assertThat(ids(cond().hasPhotos(false).build())).containsExactly(empty.getId(), failed.getId(),
				none.getId());
	}

	@Test
	void analyzedFilterAndBookmarkedFilterAndFlag() {
		Item analyzed = save(base());
		Item plain = save(base());
		Item marked = save(base());
		analyses.save(new Analysis(analyzed, "본문", "m", "v1", at("2026-10-01T00:00:00.000Z")));
		jdbc.update("INSERT INTO bookmarks (item_id, created_at) VALUES (?, '2026-10-02 00:00:00.000')",
				marked.getId());

		assertThat(ids(cond().analyzed(true).build())).containsExactly(analyzed.getId());
		assertThat(ids(cond().analyzed(false).build())).containsExactly(plain.getId(), marked.getId());
		assertThat(ids(cond().bookmarked(true).build())).containsExactly(marked.getId());
		assertThat(ids(cond().bookmarked(false).build())).containsExactly(analyzed.getId(), plain.getId());

		List<ItemResponse> all = page(cond().build()).items();
		assertThat(all).extracting(ItemResponse::bookmarked).containsExactly(false, false, true);
		// 표시용 bookmarked는 필터/total에 관여하지 않는다.
		assertThat(page(cond().build()).total()).isEqualTo(3);
	}

	@Test
	void lastChangedAtIsMaxOfChangeKindOnlyAndNullWithoutChanges() {
		Item onlyBaseline = save(base());
		Item changed = save(base());
		Item untouched = save(base());
		changes.save(new ItemChange(onlyBaseline, "minBidPrice", null, "100", at("2026-10-05T00:00:00.000Z"),
				ChangeKind.BASELINE));
		changes.save(new ItemChange(changed, "minBidPrice", null, "100", at("2026-10-09T00:00:00.000Z"),
				ChangeKind.BASELINE));
		changes.save(new ItemChange(changed, "minBidPrice", "100", "80", at("2026-10-03T01:02:03.000Z"),
				ChangeKind.CHANGE));
		changes.save(new ItemChange(changed, "status", "a", "b", at("2026-10-04T05:06:07.890Z"),
				ChangeKind.CHANGE));

		List<ItemResponse> rows = page(cond().build()).items();

		assertThat(rows).extracting(ItemResponse::id).containsExactly(onlyBaseline.getId(), changed.getId(),
				untouched.getId());
		assertThat(rows).extracting(ItemResponse::lastChangedAt).containsExactly(null,
				at("2026-10-04T05:06:07.890Z"), null);
	}

	@Test
	void paginationBoundaries() {
		List<Long> all = new java.util.ArrayList<>();
		for (int i = 0; i < 5; i++) {
			all.add(save(base()).getId());
		}

		ItemPage p1 = page(cond().page(1).pageSize(2).build());
		ItemPage p3 = page(cond().page(3).pageSize(2).build());
		ItemPage p4 = page(cond().page(4).pageSize(2).build());
		ItemPage exact = page(cond().page(2).pageSize(5).build());

		assertThat(p1.items()).extracting(ItemResponse::id).containsExactly(all.get(0), all.get(1));
		assertThat(p1.total()).isEqualTo(5);
		assertThat(p3.items()).extracting(ItemResponse::id).containsExactly(all.get(4));
		assertThat(p4.items()).isEmpty();
		assertThat(p4.total()).isEqualTo(5);
		assertThat(p4.page()).isEqualTo(4);
		assertThat(exact.items()).isEmpty();
		// int 범위를 넘는 페이지도 오류 없이 빈 목록이다.
		ItemPage far = page(cond().page(9_007_199_254_740_991L).pageSize(200).build());
		assertThat(far.items()).isEmpty();
		assertThat(far.total()).isEqualTo(5);
	}

	@Test
	void responseCarriesAllItemFieldsAndOmitsNothingExceptPhotoFields() {
		Item full = save(base().usageType("아파트").appraisalPrice(1000L).minBidPrice(800L).failedBidCount(1)
				.status("진행").minArea(30).maxArea(40).buildingDescription("설명").note("비고")
				.location(new Location("주소", "서울", "강남", "역삼", "1-1", "빌딩", "101", "1.5", "2.5", "L"))
				.schedule(new AuctionSchedule(LocalDate.parse("2026-11-01"), "1000", "법정", LocalDate.parse("2026-11-08"), 2))
				.photoInfo(new PhotoInfo(PhotoStatus.COLLECTED, 4, T0)));
		Item bare = save(base());

		ItemResponse f = page(cond().build()).items().get(0);
		ItemResponse b = page(cond().build()).items().get(1);

		assertThat(f.id()).isEqualTo(full.getId());
		assertThat(f.address()).isEqualTo("주소");
		assertThat(f.auctionDate()).isEqualTo(LocalDate.parse("2026-11-01"));
		assertThat(f.auctionRound()).isEqualTo(2);
		assertThat(f.coordinateX()).isEqualTo("1.5");
		assertThat(f.photoStatus()).isEqualTo("collected");
		assertThat(f.photoCount()).isEqualTo(4);
		assertThat(f.photoCollectedAt()).isEqualTo(T0);
		assertThat(b.id()).isEqualTo(bare.getId());
		assertThat(b.address()).isNull();
		assertThat(b.photoStatus()).isNull();
	}

	// ---- 정렬 ----

	/** 5개 물건: 정렬 5종 검증용. 생성 순서 = id 순서. */
	private record SortFixture(Item i1, Item i2, Item i3, Item i4, Item i5) {
	}

	private SortFixture sortFixture() {
		Item i1 = save(base().schedule(on("2026-11-03")).minBidPrice(300L).appraisalPrice(1000L).failedBidCount(2)
				.minArea(30));
		Item i2 = save(base().schedule(on("2026-11-01")).minBidPrice(900L).appraisalPrice(1000L).failedBidCount(0)
				.maxArea(30));
		Item i3 = save(base().appraisalPrice(1000L));
		Item i4 = save(base().schedule(on("2026-11-01")).minBidPrice(100L).appraisalPrice(0L).failedBidCount(2)
				.minArea(0).maxArea(0));
		Item i5 = save(base().schedule(on("2026-11-02")).minBidPrice(500L).appraisalPrice(1000L).failedBidCount(5)
				.minArea(10));
		return new SortFixture(i1, i2, i3, i4, i5);
	}

	private List<Long> sorted(SortKey key, SortDirection dir) {
		return ids(cond().sort(key).dir(dir).build());
	}

	@Test
	void sortByAuctionDateNullsLastAndTieBrokenById() {
		SortFixture f = sortFixture();

		assertThat(sorted(SortKey.AUCTION_DATE, SortDirection.ASC)).containsExactly(f.i2().getId(),
				f.i4().getId(), f.i5().getId(), f.i1().getId(), f.i3().getId());
		assertThat(sorted(SortKey.AUCTION_DATE, SortDirection.DESC)).containsExactly(f.i1().getId(),
				f.i5().getId(), f.i2().getId(), f.i4().getId(), f.i3().getId());
	}

	@Test
	void sortByMinBidPriceNullsLast() {
		SortFixture f = sortFixture();

		assertThat(sorted(SortKey.MIN_BID_PRICE, SortDirection.ASC)).containsExactly(f.i4().getId(),
				f.i1().getId(), f.i5().getId(), f.i2().getId(), f.i3().getId());
		assertThat(sorted(SortKey.MIN_BID_PRICE, SortDirection.DESC)).containsExactly(f.i2().getId(),
				f.i5().getId(), f.i1().getId(), f.i4().getId(), f.i3().getId());
	}

	@Test
	void sortByFailedBidCountNullsLastAndTieBrokenById() {
		SortFixture f = sortFixture();

		assertThat(sorted(SortKey.FAILED_BID_COUNT, SortDirection.ASC)).containsExactly(f.i2().getId(),
				f.i1().getId(), f.i4().getId(), f.i5().getId(), f.i3().getId());
		assertThat(sorted(SortKey.FAILED_BID_COUNT, SortDirection.DESC)).containsExactly(f.i5().getId(),
				f.i1().getId(), f.i4().getId(), f.i2().getId(), f.i3().getId());
	}

	@Test
	void sortByBidRatioNullsLastIncludingZeroAppraisal() {
		SortFixture f = sortFixture();

		// 비율: i1 0.3, i5 0.5, i2 0.9. i3(최저가 NULL)과 i4(감정가 0 -> NULLIF)는 NULL이라 id 순으로 뒤.
		assertThat(sorted(SortKey.BID_RATIO, SortDirection.ASC)).containsExactly(f.i1().getId(), f.i5().getId(),
				f.i2().getId(), f.i3().getId(), f.i4().getId());
		assertThat(sorted(SortKey.BID_RATIO, SortDirection.DESC)).containsExactly(f.i2().getId(),
				f.i5().getId(), f.i1().getId(), f.i3().getId(), f.i4().getId());
	}

	@Test
	void sortByPricePerAreaUsesMinAreaThenMaxAreaAndNullsLast() {
		SortFixture f = sortFixture();

		// 면적당: i1 300/30=10, i2 900/30(maxArea)=30, i5 500/10=50. i3(NULL)과 i4(면적 둘 다 0)는 뒤.
		assertThat(sorted(SortKey.PRICE_PER_AREA, SortDirection.ASC)).containsExactly(f.i1().getId(),
				f.i2().getId(), f.i5().getId(), f.i3().getId(), f.i4().getId());
		assertThat(sorted(SortKey.PRICE_PER_AREA, SortDirection.DESC)).containsExactly(f.i5().getId(),
				f.i2().getId(), f.i1().getId(), f.i3().getId(), f.i4().getId());
	}

	@Test
	void bidRatioSortUsesRealDivisionNotMysqlDecimalDivision() {
		// 100001/300000 = 0.3333367, 100000/300000 = 0.3333333. DECIMAL(4자리) 나눗셈이면 둘 다 0.3333이라
		// 동률이 되어 id 순(hi, lo)이 나온다. 실수 나눗셈이면 lo가 먼저다.
		Item hi = save(base().minBidPrice(100_001L).appraisalPrice(300_000L));
		Item lo = save(base().minBidPrice(100_000L).appraisalPrice(300_000L));

		assertThat(sorted(SortKey.BID_RATIO, SortDirection.ASC)).containsExactly(lo.getId(), hi.getId());
		assertThat(sorted(SortKey.BID_RATIO, SortDirection.DESC)).containsExactly(hi.getId(), lo.getId());
	}

	@Test
	void pricePerAreaSortUsesRealDivision() {
		Item hi = save(base().minBidPrice(100_001L).minArea(300_000));
		Item lo = save(base().minBidPrice(100_000L).minArea(300_000));

		assertThat(sorted(SortKey.PRICE_PER_AREA, SortDirection.ASC)).containsExactly(lo.getId(), hi.getId());
	}

	@Test
	void minDiscountRateUsesRealDivision() {
		// (3 - 1) / 3 * 100 = 66.67. 정수 나눗셈이면 0이 되어 걸러진다.
		Item a = save(base().appraisalPrice(3L).minBidPrice(1L));

		assertThat(ids(cond().minDiscountRate(66).build())).containsExactly(a.getId());
		assertThat(ids(cond().minDiscountRate(67).build())).isEmpty();
	}

	// ---- 재분석 대상 ----

	private Item analyzed(String analyzedAt, String promptVersion) {
		Item item = save(base());
		analyses.save(new Analysis(item, "본문", "m", promptVersion, at(analyzedAt)));
		return item;
	}

	private void change(Item item, String changedAt, ChangeKind kind) {
		changes.save(new ItemChange(item, "minBidPrice", "100", "80", at(changedAt), kind));
	}

	private List<Long> needs(String promptVersion) {
		return ids(cond().needsAnalysis(promptVersion).build());
	}

	@Test
	void needsAnalysisIncludesItemsChangedAfterTheLatestAnalysis() {
		Item changed = analyzed("2026-10-01T00:00:00.000Z", "v2");
		change(changed, "2026-10-02T00:00:00.000Z", ChangeKind.CHANGE);
		Item unchanged = analyzed("2026-10-01T00:00:00.000Z", "v2");

		assertThat(needs("v2")).containsExactly(changed.getId()).doesNotContain(unchanged.getId());
	}

	@Test
	void needsAnalysisIgnoresBaselineOnlyHistory() {
		Item baselineOnly = analyzed("2026-10-01T00:00:00.000Z", "v2");
		change(baselineOnly, "2026-10-02T00:00:00.000Z", ChangeKind.BASELINE);

		assertThat(needs("v2")).isEmpty();
	}

	@Test
	void needsAnalysisExcludesUnanalyzedItemsEvenWithChanges() {
		Item never = save(base());
		change(never, "2026-10-02T00:00:00.000Z", ChangeKind.CHANGE);

		assertThat(needs("v2")).isEmpty();
	}

	@Test
	void needsAnalysisIncludesDifferentPromptVersionAndExcludesSameVersion() {
		Item old = analyzed("2026-10-01T00:00:00.000Z", "v1");
		analyzed("2026-10-01T00:00:00.000Z", "v2");

		assertThat(needs("v2")).containsExactly(old.getId());
		assertThat(needs("v1")).hasSize(1).doesNotContain(old.getId());
	}

	@Test
	void needsAnalysisExcludesChangesAtOrBeforeTheLatestAnalysis() {
		Item before = analyzed("2026-10-05T00:00:00.000Z", "v2");
		change(before, "2026-10-04T00:00:00.000Z", ChangeKind.CHANGE);
		Item same = analyzed("2026-10-05T00:00:00.000Z", "v2");
		change(same, "2026-10-05T00:00:00.000Z", ChangeKind.CHANGE);

		assertThat(needs("v2")).isEmpty();
	}

	@Test
	void needsAnalysisJudgesByTheLatestAnalysisNotAnOlderOne() {
		Item item = save(base());
		analyses.save(new Analysis(item, "옛", "m", "v1", at("2026-09-01T00:00:00.000Z")));
		analyses.save(new Analysis(item, "새", "m", "v2", at("2026-10-03T00:00:00.000Z")));
		// 최신 분석 이후 변경은 없고(옛 분석 이후이긴 하다), 최신 분석의 버전은 요청과 같다.
		change(item, "2026-10-02T00:00:00.000Z", ChangeKind.CHANGE);

		assertThat(needs("v2")).isEmpty();
		assertThat(needs("v3")).containsExactly(item.getId());
	}

	@Test
	void needsAnalysisPicksTheHighestIdAmongAnalysesWithTheSameTimestamp() {
		Item item = save(base());
		analyses.save(new Analysis(item, "먼저", "m", "v1", at("2026-10-01T00:00:00.000Z")));
		analyses.save(new Analysis(item, "나중", "m", "v2", at("2026-10-01T00:00:00.000Z")));
		// id가 더 큰 분석이지만 시각이 더 오래된 행. 선택되면 안 된다.
		analyses.save(new Analysis(item, "과거", "m", "v1", at("2026-09-01T00:00:00.000Z")));

		assertThat(needs("v2")).isEmpty();
		assertThat(needs("v1")).containsExactly(item.getId());
	}

	@Test
	void needsAnalysisHonorsTheCooldownWindowFromTheInjectedClock() {
		// now = 2026-10-08T12:00Z, 간격 24시간 -> 2026-10-07T12:00Z 이전(포함)에 분석된 것만 대상.
		Item inside = analyzed("2026-10-07T12:00:00.001Z", "v1");
		Item boundary = analyzed("2026-10-07T12:00:00.000Z", "v1");
		Item outside = analyzed("2026-10-07T11:59:59.999Z", "v1");

		assertThat(needs("v2")).containsExactly(outside.getId(), boundary.getId());

		clock.set(at("2026-10-08T12:00:00.001Z"));
		assertThat(needs("v2")).containsExactly(outside.getId(), boundary.getId(), inside.getId());
	}

	@Test
	void needsAnalysisIsOrderedByOldestAnalysisThenIdAndIgnoresSort() {
		Item newest = analyzed("2026-10-01T00:00:00.000Z", "v1");
		Item oldest = analyzed("2026-09-20T00:00:00.000Z", "v1");
		Item tieA = analyzed("2026-09-25T00:00:00.000Z", "v1");
		Item tieB = analyzed("2026-09-25T00:00:00.000Z", "v1");

		List<Long> expected = List.of(oldest.getId(), tieA.getId(), tieB.getId(), newest.getId());
		assertThat(needs("v2")).isEqualTo(expected);
		assertThat(ids(cond().needsAnalysis("v2").sort(SortKey.MIN_BID_PRICE).dir(SortDirection.DESC).build()))
				.isEqualTo(expected);
		assertThat(page(cond().needsAnalysis("v2").build()).total()).isEqualTo(4);
	}

	@Test
	void needsAnalysisCombinesWithOtherFilters() {
		Item seoul = analyzed("2026-10-01T00:00:00.000Z", "v1");
		jdbc.update("UPDATE items SET sido = '서울특별시' WHERE id = ?", seoul.getId());
		Item busan = analyzed("2026-10-01T00:00:00.000Z", "v1");
		jdbc.update("UPDATE items SET sido = '부산광역시' WHERE id = ?", busan.getId());

		assertThat(ids(cond().needsAnalysis("v2").sido("서울특별시").build())).containsExactly(seoul.getId());
	}

}
