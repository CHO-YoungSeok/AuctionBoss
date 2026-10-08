package com.auctionboss.collect.source.courtauction;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.auctionboss.collect.source.CourtRef;
import com.auctionboss.collect.source.SourceItem;
import com.auctionboss.collect.source.SourceRequestException;
import java.io.IOException;
import java.io.InputStream;
import java.util.List;
import java.util.stream.Collectors;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/**
 * 2.4: 행 접기·정규화와 값 변환의 경계값. TS 어댑터 테스트의 "정규화"·"회귀" 묶음과, 1.2에서 실측한 {@code Number()} 의미(design D9)를
 * 옮겼다. 기대값은 같은 입력을 Node에서 돌려 확인한 값이다.
 */
class RowFolderTest {

	private static final JsonMapper JSON = JsonMapper.builder().build();

	private static final JsonNode ROWS = load("contracts/source/fixtures/search-rows.json");

	private static final CourtRef COURT = new CourtRef("서울중앙지방법원", "B000210");

	private static JsonNode load(String path) {
		try (InputStream in = RowFolderTest.class.getClassLoader().getResourceAsStream(path)) {
			return JSON.readTree(in);
		}
		catch (IOException e) {
			throw new IllegalStateException(e);
		}
	}

	private static List<SearchRow> rows(JsonNode... nodes) {
		String array = "[" + java.util.Arrays.stream(nodes).map(JsonNode::toString).collect(Collectors.joining(",")) + "]";
		return SearchResponseParser
			.parse("{\"data\":{\"ipcheck\":true,\"dma_pageInfo\":{\"totalCnt\":1},\"dlt_srchResult\":" + array + "}}")
			.rows();
	}

	private static JsonNode with(JsonNode row, String key, String value) {
		return ((tools.jackson.databind.node.ObjectNode) row.deepCopy()).put(key, value);
	}

	private static SourceItem foldOne(JsonNode... nodes) {
		List<SourceItem> items = RowFolder.fold(rows(nodes), COURT);
		assertThat(items).hasSize(1);
		return items.get(0);
	}

	private static Numericish n(String text) {
		return Numericish.ofText(text);
	}

	// ------------------------------------------------------------- toInt / toIntNonZero

	@ParameterizedTest
	@CsvSource(delimiter = '|', nullValues = "NULL", value = { "0x10|16", "1e3|1000", "'1,234'|1234", "+7|7", "-7|-7",
			"１２３|NULL", "1_000|NULL", "Infinity|NULL", "-Infinity|NULL", "1.9|1", "-1.9|-1", "-0.5|0", ".5|0",
			"5.|5", "0b101|5", "0o17|15", "-0x10|NULL", "abc|NULL", "12abc|NULL", "0x|NULL", "1e|NULL",
			"0.0000001|0", "'1,2,3'|123", "','|NULL", "٣|NULL", "9007199254740993|9007199254740992", "711000000|711000000",
			"51005255120|51005255120" })
	void toIntFollowsJavaScriptNumberSemantics(String input, Long expected) {
		assertThat(RowFolder.toInt(n(input))).isEqualTo(expected);
	}

	@Test
	void toIntTrimsTheJavaScriptWhitespaceSetAndTreatsBlankAsNone() {
		assertThat(RowFolder.toInt(n(" 12 "))).isEqualTo(12);
		assertThat(RowFolder.toInt(n(" 12 "))).isEqualTo(12);
		assertThat(RowFolder.toInt(n("﻿12"))).isEqualTo(12);
		assertThat(RowFolder.toInt(n(" 12 "))).isEqualTo(12);
		assertThat(RowFolder.toInt(n(""))).isNull();
		assertThat(RowFolder.toInt(n("   "))).isNull();
		assertThat(RowFolder.toInt(null)).isNull();
	}

	@Test
	void toIntOnJsonNumbersTruncatesTowardZeroAndRejectsNonFinite() {
		assertThat(RowFolder.toInt(Numericish.ofNumber(1.9))).isEqualTo(1);
		assertThat(RowFolder.toInt(Numericish.ofNumber(-2.7))).isEqualTo(-2);
		assertThat(RowFolder.toInt(Numericish.ofNumber(Double.NaN))).isNull();
		assertThat(RowFolder.toInt(Numericish.ofNumber(Double.POSITIVE_INFINITY))).isNull();
		assertThat(RowFolder.toInt(Numericish.ofNumber(51_005_255_120d))).isEqualTo(51_005_255_120L);
	}

	@Test
	void valuesBeyondLongAreNoneInJavaWhereTsPassedThemThrough() {
		// TS는 1e30을 그대로 통과시키지만 Java 모델은 Long이라 변환 불가(없음)로 다룬다(design D9 결정).
		assertThat(RowFolder.toInt(n("1e30"))).isNull();
		assertThat(RowFolder.toInt(Numericish.ofNumber(1e30))).isNull();
		assertThat(RowFolder.toInt(n("9223372036854775808"))).isNull();
		assertThat(RowFolder.toInt(n("-9223372036854775808"))).isEqualTo(Long.MIN_VALUE);
	}

	@Test
	void toIntNonZeroFoldsZeroToNoneButKeepsOtherValues() {
		assertThat(RowFolder.toIntNonZero(n("0"))).isNull();
		assertThat(RowFolder.toIntNonZero(n("-0.5"))).isNull();
		assertThat(RowFolder.toIntNonZero(n(""))).isNull();
		assertThat(RowFolder.toIntNonZero(n("84"))).isEqualTo(84);
		assertThat(RowFolder.toIntNonZero(n("-3"))).isEqualTo(-3);
		assertThat(RowFolder.toInt(n("0"))).isZero();
	}

	// ------------------------------------------------------------- text / toIsoDate / deriveStatus

	@Test
	void textTrimsAndFoldsBlankToNone() {
		assertThat(RowFolder.text("  가나다 \n")).isEqualTo("가나다");
		assertThat(RowFolder.text(" 　")).isNull();
		assertThat(RowFolder.text("")).isNull();
		assertThat(RowFolder.text(null)).isNull();
		assertThat(RowFolder.text("a\nb")).isEqualTo("a\nb");
	}

	@ParameterizedTest
	@CsvSource(delimiter = '|', nullValues = "NULL", value = { "20260908|2026-09-08", "' 20260908 '|2026-09-08", "|NULL",
			"2026-09-08|NULL", "2026090|NULL", "202609080|NULL", "２０２６０９０８|NULL", "abcdefgh|NULL" })
	void toIsoDateOnlyAcceptsEightAsciiDigits(String input, String expected) {
		assertThat(RowFolder.toIsoDate(input)).isEqualTo(expected);
	}

	@Test
	void toIsoDateKeepsAnImpossibleButWellFormedDateAsIs() {
		// TS는 형식만 본다(달력 검증 없음). 같게 둔다.
		assertThat(RowFolder.toIsoDate("20261399")).isEqualTo("2026-13-99");
		assertThat(RowFolder.toIsoDate(null)).isNull();
	}

	@Test
	void deriveStatusMatchesTheScreenRule() {
		assertThat(RowFolder.deriveStatus(null)).isNull();
		assertThat(RowFolder.deriveStatus(0L)).isEqualTo("신건");
		assertThat(RowFolder.deriveStatus(1L)).isEqualTo("유찰 1회");
		assertThat(RowFolder.deriveStatus(16L)).isEqualTo("유찰 16회");
	}

	// ------------------------------------------------------------- pickAddress / pickMinBidPrice

	@Test
	void pickAddressPrefersTheFirstJibunRowThenAnyRowWithAnAddress() {
		JsonNode base = ROWS.get("realRow");
		JsonNode road = with(with(base, "addrGbncd", "R"), "printSt", "도로명 1");
		JsonNode jibun1 = with(with(base, "addrGbncd", "A"), "printSt", "지번 1");
		JsonNode jibun2 = with(with(base, "addrGbncd", "A"), "printSt", "지번 2");
		JsonNode blankJibun = with(with(base, "addrGbncd", "A"), "printSt", "  ");

		assertThat(RowFolder.pickAddress(rows(road, jibun1, jibun2))).isEqualTo("지번 1");
		assertThat(RowFolder.pickAddress(rows(road))).isEqualTo("도로명 1");
		assertThat(RowFolder.pickAddress(rows(blankJibun, road))).isEqualTo("도로명 1");
		assertThat(RowFolder.pickAddress(rows(blankJibun))).isNull();
	}

	@Test
	void pickAddressWithoutTheAddressKindFieldFallsBackToTheFirstAddress() {
		JsonNode noKind = ((tools.jackson.databind.node.ObjectNode) ROWS.get("realRow").deepCopy()).without("addrGbncd");

		assertThat(RowFolder.pickAddress(rows(noKind))).isNotNull();
	}

	@Test
	void pickMinBidPriceUsesTheNoticePriceThenFallsBack() {
		JsonNode base = ROWS.get("realRow");
		assertThat(RowFolder.pickMinBidPrice(rows(base).get(0))).isEqualTo(711_000_000L);
		JsonNode zeroNotice = with(with(base, "notifyMinmaePrice1", "0"), "minmaePrice", "500");
		assertThat(RowFolder.pickMinBidPrice(rows(zeroNotice).get(0))).isEqualTo(500L);
		JsonNode bothZero = with(with(base, "notifyMinmaePrice1", "0"), "minmaePrice", "0");
		assertThat(RowFolder.pickMinBidPrice(rows(bothZero).get(0))).isEqualTo(0L);
		JsonNode noticeBlankFallbackZero = with(with(base, "notifyMinmaePrice1", ""), "minmaePrice", "0");
		assertThat(RowFolder.pickMinBidPrice(rows(noticeBlankFallbackZero).get(0))).isEqualTo(0L);
		JsonNode bothBlank = with(with(base, "notifyMinmaePrice1", ""), "minmaePrice", "");
		assertThat(RowFolder.pickMinBidPrice(rows(bothBlank).get(0))).isNull();
	}

	// ------------------------------------------------------------- 접기·정규화(회귀)

	@Test
	void theRealRowMapsToTheNormalizedItem() {
		SourceItem item = foldOne(ROWS.get("realRow"));

		assertThat(item.court()).isEqualTo("서울중앙지방법원");
		assertThat(item.caseNo()).isEqualTo("2011타경28497");
		assertThat(item.itemNo()).isEqualTo("1");
		assertThat(item.appraisalPrice()).isEqualTo(711_000_000L);
		assertThat(item.minBidPrice()).isEqualTo(711_000_000L);
		assertThat(item.auctionDate()).isEqualTo("2026-09-08");
		assertThat(item.failedBidCount()).isEqualTo(1L);
		assertThat(item.status()).isEqualTo("유찰 1회");
		assertThat(item.buildingDescription()).isEqualTo("철근콘크리트구조\n84.99㎡");
		assertThat(item.minBidPriceRound2()).isNull();
		assertThat(item.minBidPriceRateRound1()).isEqualTo(100L);
		assertThat(item.coordinateX()).isEqualTo("312690");
		assertThat(item.coordinateLevel()).isNull();
		assertThat(item.note()).isNull();
		assertThat(item.duplicateCaseNo()).isEqualTo("2015타경14083<br/>2021타경102844");
		assertThat(item.internalCaseNo()).isEqualTo("20110130028497").isNotEqualTo(item.caseNo());
		assertThat(item.courtCode()).isEqualTo("B000210");
	}

	@Test
	void identifiersAreNoneWhenTheRowLacksThem() {
		JsonNode row = ((tools.jackson.databind.node.ObjectNode) ROWS.get("realRow").deepCopy()).without("saNo").without("boCd");
		SourceItem item = foldOne(row);

		assertThat(item.internalCaseNo()).isNull();
		assertThat(item.courtCode()).isNull();
	}

	@Test
	void zeroFailedBidsIsNewAndNoneIsNotZero() {
		JsonNode base = ROWS.get("realRow");
		assertThat(foldOne(with(base, "yuchalCnt", "0")).status()).isEqualTo("신건");
		assertThat(foldOne(with(base, "yuchalCnt", "0")).failedBidCount()).isZero();
		SourceItem none = foldOne(with(base, "yuchalCnt", ""));
		assertThat(none.failedBidCount()).isNull();
		assertThat(none.status()).isNull();
	}

	@Test
	void bundleRowsFoldIntoOneItemWithTheJibunAddress() {
		List<JsonNode> bundle = ROWS.get("bundleRows").valueStream().toList();
		List<SourceItem> items = RowFolder.fold(rows(bundle.toArray(JsonNode[]::new)), COURT);

		assertThat(items).hasSize(1);
		assertThat(items.get(0).address()).isEqualTo("서울특별시 종로구 종로4가 185");
	}

	@Test
	void groupsKeepFirstSeenOrderAndRowsWithAMissingKeyAreDropped() {
		JsonNode a = ROWS.get("realRow");
		JsonNode b = with(a, "srnSaNo", "2026타경2");
		JsonNode c = with(a, "srnSaNo", "2026타경1");
		JsonNode missing = with(a, "srnSaNo", " ");

		List<SourceItem> items = RowFolder.fold(rows(b, missing, c, b), COURT);

		assertThat(items).extracting(SourceItem::caseNo).containsExactly("2026타경2", "2026타경1");
		assertThat(RowFolder.fold(rows(missing), COURT)).isEmpty();
		assertThat(RowFolder.fold(List.of(), COURT)).isEmpty();
	}

	@Test
	void rowsWithoutExtendedFieldsStillGiveTheCoreFields() {
		SourceItem item = foldOne(ROWS.get("noExtendedFieldsRow"));

		assertThat(item.caseNo()).isNotNull();
		assertThat(RowFolder.hasAnyExtendedField(item)).isFalse();
		assertThat(item.internalCaseNo()).as("식별자는 확장 필드 묶음이 아니다").isNotNull();
		assertThat(RowFolder.hasAnyExtendedField(foldOne(ROWS.get("realRow")))).isTrue();
	}

	@Test
	void extendedZeroValuesBecomeNoneWhileTheFailedBidCountKeepsZero() {
		JsonNode row = with(with(with(with(ROWS.get("realRow"), "minArea", "0"), "notifyMinmaePrice2", "0"),
				"notifyMinmaePriceRate1", "0"), "maeGiilCnt", "0");
		SourceItem item = foldOne(row);

		assertThat(item.minArea()).isNull();
		assertThat(item.minBidPriceRound2()).isNull();
		assertThat(item.minBidPriceRateRound1()).isNull();
		assertThat(item.auctionRound()).isNull();
		assertThat(item.maxArea()).isEqualTo(84L);
	}

	// ------------------------------------------------------------- 법원 코드

	@Test
	void resolveCourtCodeUsesTheConfiguredCodeThenTheNameTable() {
		assertThat(RowFolder.resolveCourtCode(new CourtRef("아무", " B999999 "), "u")).isEqualTo("B999999");
		assertThat(RowFolder.resolveCourtCode(new CourtRef("서울중앙지방법원", ""), "u")).isEqualTo("B000210");
		assertThat(RowFolder.resolveCourtCode(new CourtRef(" 제주지방법원 ", "  "), "u")).isEqualTo("B000530");
		assertThat(RowFolder.resolveCourtCode(new CourtRef("서울동부지방법원", ""), "u")).isEqualTo("B000211");
	}

	@Test
	void anUnknownCourtNameWithoutACodeIsARequestError() {
		assertThatThrownBy(() -> RowFolder.resolveCourtCode(new CourtRef("존재하지않는법원", ""), "http://x/search"))
			.isInstanceOfSatisfying(SourceRequestException.class, e -> {
				assertThat(e.getMessage()).isEqualTo(
						"법원 코드를 알 수 없습니다: \"존재하지않는법원\" — config/collector.json의 courtCode를 채우세요");
				assertThat(e.url()).isEqualTo("http://x/search");
			});
	}

}
