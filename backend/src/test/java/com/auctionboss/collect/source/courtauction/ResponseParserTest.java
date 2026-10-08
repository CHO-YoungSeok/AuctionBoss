package com.auctionboss.collect.source.courtauction;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.auctionboss.collect.source.ResponseSchemaException;
import com.auctionboss.collect.source.RobotDetectedException;
import com.auctionboss.collect.source.SourceBlockedException;
import com.auctionboss.collect.source.WafBlockedException;
import java.io.IOException;
import java.io.InputStream;
import java.util.List;

import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/**
 * 2.3: 검색·상세 응답 3단 검사(본문 첫 글자, {@code data} 객체, {@code ipcheck}, 형식)의 분류. TS {@code parseSearchResponse}·
 * {@code parseDetailResponse} 테스트 사례를 옮겼다. 입력은 골든 픽스처({@code contracts/source/fixtures/bodies.json})와 합성 본문이다.
 */
class ResponseParserTest {

	private static final JsonMapper JSON = JsonMapper.builder().build();

	private static final JsonNode BODIES = load("contracts/source/fixtures/bodies.json");

	private static final String WAF = BODIES.get("wafBlocked").asString();

	private static final String ROBOT = BODIES.get("robotBlocked").asString();

	private static JsonNode load(String path) {
		try (InputStream in = ResponseParserTest.class.getClassLoader().getResourceAsStream(path)) {
			return JSON.readTree(in);
		}
		catch (IOException e) {
			throw new IllegalStateException(e);
		}
	}

	private static String validSearch(String rows, String totalCnt) {
		return "{\"status\":200,\"data\":{\"ipcheck\":true,\"dma_pageInfo\":{\"pageNo\":1,\"totalCnt\":" + totalCnt
				+ "},\"dlt_srchResult\":" + rows + "}}";
	}

	// ------------------------------------------------------------- 검색

	@Test
	void htmlBodyIsWafBlockedEvenThoughHttpWas200() {
		assertThatThrownBy(() -> SearchResponseParser.parse(WAF)).isInstanceOfSatisfying(WafBlockedException.class, e -> {
			assertThat(e).isInstanceOf(SourceBlockedException.class);
			assertThat(e.bodyPreview()).contains("Web firewall security policies");
			assertThat(e.kind()).isEqualTo("WafBlockedError");
		});
	}

	@Test
	void ipcheckNotTrueIsRobotDetectedAndKeepsTheSourceMessage() {
		assertThatThrownBy(() -> SearchResponseParser.parse(ROBOT)).isInstanceOfSatisfying(RobotDetectedException.class,
				e -> {
					assertThat(e).isInstanceOf(SourceBlockedException.class);
					assertThat(e.sourceMessage()).contains("차단되었습니다");
				});
	}

	@Test
	void ipcheckThatIsMissingOrNotTheBooleanTrueIsStillBlocked() {
		for (String data : List.of("{}", "{\"ipcheck\":\"true\"}", "{\"ipcheck\":1}", "{\"ipcheck\":null}", "[]")) {
			assertThatThrownBy(() -> SearchResponseParser.parse("{\"data\":" + data + "}")).as(data)
				.isInstanceOfSatisfying(RobotDetectedException.class, e -> assertThat(e.sourceMessage()).isNull());
		}
	}

	@Test
	void aMessageThatIsNotAStringIsNotKept() {
		assertThatThrownBy(() -> SearchResponseParser.parse("{\"message\":5,\"data\":{\"ipcheck\":false}}"))
			.isInstanceOfSatisfying(RobotDetectedException.class, e -> assertThat(e.sourceMessage()).isNull());
	}

	@Test
	void rowsThatAreNotAnArrayAreASchemaErrorWithIssueDetail() {
		assertThatThrownBy(() -> SearchResponseParser.parse(BODIES.get("schemaViolation").asString()))
			.isInstanceOfSatisfying(ResponseSchemaException.class, e -> {
				assertThat(String.join("\n", e.issues())).contains("dlt_srchResult");
				assertThat(e.getMessage()).contains("dlt_srchResult");
				assertThat(e.getMessage().split("\n")[0]).startsWith("응답 형식이 기대와 다릅니다");
			});
	}

	@Test
	void missingPageInfoIsASchemaError() {
		assertThatThrownBy(() -> SearchResponseParser.parse(BODIES.get("missingPageInfo").asString()))
			.isInstanceOfSatisfying(ResponseSchemaException.class,
					e -> assertThat(e.issues()).anyMatch(i -> i.startsWith("dma_pageInfo")));
	}

	@Test
	void missingDataIsASchemaErrorNotABlock() {
		// data 자체가 사라진 경우까지 차단으로 오판하면 1시간 백오프에 잘못 들어간다.
		for (String body : List.of("{\"status\":500,\"message\":\"oops\"}", "{\"status\":500}", "{\"data\":null}",
				"{\"data\":\"x\"}", "{\"data\":5}")) {
			assertThatThrownBy(() -> SearchResponseParser.parse(body)).as(body)
				.isInstanceOf(ResponseSchemaException.class)
				.isNotInstanceOf(SourceBlockedException.class)
				.hasMessageStartingWith("응답에 data 객체가 없습니다");
		}
	}

	@Test
	void brokenJsonThatStartsWithABraceIsASchemaErrorAndTrailingTextToo() {
		assertThatThrownBy(() -> SearchResponseParser.parse("{\"data\":")).isInstanceOf(ResponseSchemaException.class)
			.hasMessageStartingWith("응답 본문을 JSON으로 파싱하지 못했습니다");
		assertThatThrownBy(() -> SearchResponseParser.parse("{\"data\":{}} trailing"))
			.isInstanceOf(ResponseSchemaException.class);
	}

	@Test
	void leadingWhitespaceAndBomBeforeTheBraceAreAllowed() {
		String body = validSearch("[]", "0");

		assertThat(SearchResponseParser.parse("  \n﻿" + body).rows()).isEmpty();
	}

	@Test
	void bodyThatStartsWithAnArrayOrTextIsWafBlocked() {
		assertThatThrownBy(() -> SearchResponseParser.parse("[]")).isInstanceOf(WafBlockedException.class);
		assertThatThrownBy(() -> SearchResponseParser.parse("")).isInstanceOf(WafBlockedException.class);
	}

	@Test
	void theBlockCheckComesAfterTheDataObjectCheckAndBeforeTheFormatCheck() {
		// ipcheck=false인 본문에 형식 오류가 있어도 차단이 먼저다.
		assertThatThrownBy(() -> SearchResponseParser.parse("{\"data\":{\"ipcheck\":false,\"dlt_srchResult\":5}}"))
			.isInstanceOf(RobotDetectedException.class);
		// ipcheck=true인 본문은 형식을 본다.
		assertThatThrownBy(() -> SearchResponseParser.parse("{\"data\":{\"ipcheck\":true,\"dlt_srchResult\":5}}"))
			.isInstanceOf(ResponseSchemaException.class);
	}

	@Test
	void aValidResponseGivesRowsAndTheTotalRowCount() {
		SearchPage page = SearchResponseParser.parse(validSearch(
				"[{\"srnSaNo\":\"2026타경1\",\"gamevalAmt\":123,\"yuchalCnt\":\"2\",\"extra\":{\"ignored\":true}},{}]", "\"5\""));

		assertThat(page.rows()).hasSize(2);
		assertThat(RowFolder.toInt(page.totalCnt())).isEqualTo(5);
		assertThat(page.rows().get(0).srnSaNo()).isEqualTo("2026타경1");
		assertThat(RowFolder.toInt(page.rows().get(0).gamevalAmt())).isEqualTo(123);
		assertThat(RowFolder.toInt(page.rows().get(0).yuchalCnt())).isEqualTo(2);
		assertThat(page.rows().get(1).srnSaNo()).isNull();
	}

	@Test
	void totalCntIsRequiredAndMayBeAStringOrANumber() {
		assertThat(RowFolder.toInt(SearchResponseParser.parse(validSearch("[]", "7")).totalCnt())).isEqualTo(7);
		assertThatThrownBy(() -> SearchResponseParser.parse(
				"{\"data\":{\"ipcheck\":true,\"dma_pageInfo\":{},\"dlt_srchResult\":[]}}"))
			.isInstanceOfSatisfying(ResponseSchemaException.class,
					e -> assertThat(e.issues()).anyMatch(i -> i.startsWith("dma_pageInfo.totalCnt")));
		assertThatThrownBy(() -> SearchResponseParser.parse(validSearch("[]", "true")))
			.isInstanceOf(ResponseSchemaException.class);
	}

	@Test
	void aRowFieldOfTheWrongTypeOrANonObjectRowIsASchemaErrorNamingThePath() {
		assertThatThrownBy(() -> SearchResponseParser.parse(validSearch("[{},{\"srnSaNo\":5,\"gamevalAmt\":true}]", "1")))
			.isInstanceOfSatisfying(ResponseSchemaException.class, e -> assertThat(e.issues()).containsExactly(
					"dlt_srchResult.1.srnSaNo: Invalid input: expected string, received number",
					"dlt_srchResult.1.gamevalAmt: Invalid input: expected string | number, received boolean"));
		assertThatThrownBy(() -> SearchResponseParser.parse(validSearch("[[],null,\"x\"]", "1")))
			.isInstanceOfSatisfying(ResponseSchemaException.class, e -> assertThat(e.issues()).hasSize(3));
	}

	// ------------------------------------------------------------- 상세

	private static String detail(String baseInfo, String pics) {
		return "{\"status\":200,\"data\":{\"ipcheck\":true,\"dma_result\":{\"csBaseInfo\":" + baseInfo + ",\"csPicLst\":"
				+ pics + "}}}";
	}

	@Test
	void aValidDetailResponseGivesPicEntriesInOrder() {
		List<DetailPic> pics = DetailResponseParser.parse(detail("{\"cortOfcCd\":\"B000210\",\"clmAmt\":1000}",
				"[{\"cortAuctnPicSeq\":\"1\",\"picFile\":\"AAAA\",\"x\":1},{\"cortAuctnPicSeq\":2,\"picFile\":null}]"));

		assertThat(pics).hasSize(2);
		assertThat(pics.get(0).seq().toJsNumber()).isEqualTo(1.0);
		assertThat(pics.get(0).picFile()).isEqualTo("AAAA");
		assertThat(pics.get(1).seq().toJsNumber()).isEqualTo(2.0);
		assertThat(pics.get(1).picFile()).isNull();
	}

	@Test
	void detailHtmlIsWafAndIpcheckFalseIsRobotWithMessage() {
		assertThatThrownBy(() -> DetailResponseParser.parse(WAF)).isInstanceOf(WafBlockedException.class);
		assertThatThrownBy(() -> DetailResponseParser.parse(ROBOT)).isInstanceOfSatisfying(RobotDetectedException.class,
				e -> assertThat(e.sourceMessage()).contains("차단되었습니다"));
	}

	@Test
	void detailStructureProblemsAreSchemaErrors() {
		assertThatThrownBy(() -> DetailResponseParser.parse(BODIES.get("detailMissingResult").asString()))
			.isInstanceOfSatisfying(ResponseSchemaException.class,
					e -> assertThat(e.issues()).anyMatch(i -> i.startsWith("dma_result")));
		assertThatThrownBy(() -> DetailResponseParser.parse(BODIES.get("detailSchemaViolation").asString()))
			.isInstanceOf(ResponseSchemaException.class);
		assertThatThrownBy(() -> DetailResponseParser.parse(detail("{}", "{}")))
			.isInstanceOfSatisfying(ResponseSchemaException.class,
					e -> assertThat(e.issues()).anyMatch(i -> i.startsWith("dma_result.csPicLst")));
		assertThatThrownBy(() -> DetailResponseParser.parse(detail("null", "[]")))
			.isInstanceOfSatisfying(ResponseSchemaException.class,
					e -> assertThat(e.issues()).anyMatch(i -> i.startsWith("dma_result.csBaseInfo")));
		assertThatThrownBy(() -> DetailResponseParser.parse("{\"status\":200}")).isInstanceOf(ResponseSchemaException.class)
			.isNotInstanceOf(SourceBlockedException.class);
		assertThatThrownBy(() -> DetailResponseParser.parse("{\"data\":")).isInstanceOf(ResponseSchemaException.class)
			.hasMessageStartingWith("상세 응답 본문을 JSON으로 파싱하지 못했습니다");
	}

	@Test
	void detailFieldsOfTheWrongTypeAreSchemaErrors() {
		assertThatThrownBy(() -> DetailResponseParser.parse(detail("{\"cortOfcNm\":5}", "[{\"picFile\":7}]")))
			.isInstanceOfSatisfying(ResponseSchemaException.class, e -> assertThat(e.issues()).containsExactly(
					"dma_result.csBaseInfo.cortOfcNm: Invalid input: expected string, received number",
					"dma_result.csPicLst.0.picFile: Invalid input: expected string, received number"));
	}

}
