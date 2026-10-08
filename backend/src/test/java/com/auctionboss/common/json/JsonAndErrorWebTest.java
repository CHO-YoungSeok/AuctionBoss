package com.auctionboss.common.json;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.time.Instant;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import com.auctionboss.common.error.ApiExceptionHandler;
import com.auctionboss.common.error.FieldIssue;
import com.auctionboss.common.error.InvalidRequestException;
import com.auctionboss.item.AuctionSchedule;
import com.auctionboss.item.Item;
import com.auctionboss.item.ItemNotFoundException;
import com.auctionboss.item.PhotoInfo;
import com.auctionboss.item.dto.ItemResponse;
import com.auctionboss.photo.PhotoStatus;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.webmvc.test.autoconfigure.WebMvcTest;
import org.springframework.context.annotation.Import;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/** 5.1: 전역 JSON 형식(시각, 날짜, null 규칙)과 오류 응답 형태. 실제 MVC 스택 위에서 확인한다. */
@WebMvcTest(controllers = JsonAndErrorWebTest.StubController.class)
@Import({ JsonConfig.class, ApiExceptionHandler.class, JsonAndErrorWebTest.StubController.class })
class JsonAndErrorWebTest {

	/** 원본 toAuctionItem이 내보내는 키 순서. photoStatus, photoCount는 값이 있을 때만 나온다. */
	private static final List<String> ITEM_KEYS = List.of("id", "court", "caseNo", "itemNo", "address", "usageType",
			"appraisalPrice", "minBidPrice", "auctionDate", "failedBidCount", "status", "firstSeenAt", "lastSeenAt",
			"lastChangedAt", "bookmarked", "minArea", "maxArea", "buildingDescription", "minBidPriceRound1",
			"minBidPriceRound2", "minBidPriceRound3", "minBidPriceRound4", "minBidPriceRateRound1",
			"minBidPriceRateRound2", "usageCodeLarge", "usageCodeMedium", "usageCodeSmall", "sido", "sigungu",
			"dong", "lotNumber", "buildingName", "buildingUnit", "coordinateX", "coordinateY", "coordinateLevel",
			"auctionTime", "auctionPlace", "auctionDecisionDate", "auctionRound", "note", "duplicateCaseNo",
			"mergedCaseNo", "courtDepartment", "courtPhone", "statusCode", "itemStatusCode", "internalCaseNo",
			"courtCode", "photoStatus", "photoCount", "photoCollectedAt");

	@RestController
	static class StubController {

		@GetMapping("/stub/times")
		Map<String, Object> times() {
			return Map.of("zeroMillis", Instant.parse("2026-09-08T11:48:38Z"), "withMillis",
					Instant.parse("2026-09-08T11:48:38.617Z"), "micros", Instant.parse("2026-09-08T11:48:38.617999Z"),
					"date", LocalDate.of(2026, 9, 8));
		}

		@GetMapping("/stub/bare-item")
		ItemResponse bareItem() {
			Instant t = Instant.parse("2026-09-08T11:48:38Z");
			return ItemResponse.of(Item.builder("서울중앙지방법원", "2025타경1", "1", t, t).build(), null, false);
		}

		@GetMapping("/stub/full-item")
		ItemResponse fullItem() {
			Instant t = Instant.parse("2026-09-08T11:48:38Z");
			Item item = Item.builder("서울중앙지방법원", "2025타경1", "1", t, t)
					.schedule(new AuctionSchedule(LocalDate.of(2026, 10, 1), "1000", null, null, 1))
					.photoInfo(new PhotoInfo(PhotoStatus.COLLECTED, 3, t)).build();
			return ItemResponse.of(item, Instant.parse("2026-09-09T00:00:00Z"), true);
		}

		@GetMapping("/stub/invalid")
		void invalid() {
			throw new InvalidRequestException(
					List.of(new FieldIssue("sort", "sort가 잘못되었습니다"), new FieldIssue("minPrice", "정수여야 합니다")));
		}

		@GetMapping("/stub/not-found")
		void notFound() {
			throw new ItemNotFoundException("999999");
		}

		@GetMapping("/stub/boom")
		void boom() {
			throw new IllegalStateException("내부 사정: 비밀 정보");
		}

	}

	@Autowired
	MockMvc mvc;

	private static final JsonMapper JSON = JsonMapper.builder().build();

	@Test
	void instantsAreAlwaysMillisecondPrecisionUtc() throws Exception {
		mvc.perform(get("/stub/times")).andExpect(status().isOk())
				.andExpect(jsonPath("$.zeroMillis").value("2026-09-08T11:48:38.000Z"))
				.andExpect(jsonPath("$.withMillis").value("2026-09-08T11:48:38.617Z"))
				.andExpect(jsonPath("$.micros").value("2026-09-08T11:48:38.617Z"))
				.andExpect(jsonPath("$.date").value("2026-09-08"));
	}

	@Test
	void serializerFormatKeepsThreeDigitsForZeroMillis() {
		assertThat(InstantMillisSerializer.format(Instant.parse("2026-01-02T03:04:05Z")))
				.isEqualTo("2026-01-02T03:04:05.000Z");
		assertThat(InstantMillisSerializer.format(Instant.parse("2026-01-02T03:04:05.100Z")))
				.isEqualTo("2026-01-02T03:04:05.100Z");
		assertThat(InstantMillisSerializer.format(Instant.parse("2026-01-02T03:04:05.678Z")))
				.isEqualTo("2026-01-02T03:04:05.678Z");
	}

	@Test
	void nullFieldsAreWrittenAsNullExceptPhotoStatusAndPhotoCount() throws Exception {
		String body = mvc.perform(get("/stub/bare-item")).andExpect(status().isOk()).andReturn().getResponse()
				.getContentAsString();
		JsonNode node = JSON.readTree(body);

		List<String> keys = new ArrayList<>();
		node.propertyNames().forEach(keys::add);
		List<String> expected = new ArrayList<>(ITEM_KEYS);
		expected.remove("photoStatus");
		expected.remove("photoCount");
		assertThat(keys).containsExactlyElementsOf(expected);
		assertThat(node.get("address").isNull()).isTrue();
		assertThat(node.get("lastChangedAt").isNull()).isTrue();
		assertThat(node.get("photoCollectedAt").isNull()).isTrue();
		assertThat(node.get("bookmarked").booleanValue()).isFalse();
		assertThat(node.get("firstSeenAt").asString()).isEqualTo("2026-09-08T11:48:38.000Z");
	}

	@Test
	void photoFieldsAppearWhenPresentAndKeyOrderMatchesTheOriginal() throws Exception {
		String body = mvc.perform(get("/stub/full-item")).andExpect(status().isOk())
				.andExpect(jsonPath("$.photoStatus").value("collected")).andExpect(jsonPath("$.photoCount").value(3))
				.andExpect(jsonPath("$.auctionDate").value("2026-10-01"))
				.andExpect(jsonPath("$.auctionTime").value("1000"))
				.andExpect(jsonPath("$.lastChangedAt").value("2026-09-09T00:00:00.000Z"))
				.andExpect(jsonPath("$.photoCollectedAt").value("2026-09-08T11:48:38.000Z"))
				.andExpect(jsonPath("$.bookmarked").value(true)).andReturn().getResponse().getContentAsString();
		List<String> keys = new ArrayList<>();
		JSON.readTree(body).propertyNames().forEach(keys::add);
		assertThat(keys).containsExactlyElementsOf(ITEM_KEYS);
	}

	@Test
	void validationFailureIs400WithErrorAndDetails() throws Exception {
		mvc.perform(get("/stub/invalid")).andExpect(status().isBadRequest())
				.andExpect(content().json("""
						{"error":"잘못된 요청 파라미터입니다","details":[{"field":"sort","message":"sort가 잘못되었습니다"},{"field":"minPrice","message":"정수여야 합니다"}]}""",
						true));
	}

	@Test
	void notFoundIs404WithOnlyTheErrorField() throws Exception {
		mvc.perform(get("/stub/not-found")).andExpect(status().isNotFound())
				.andExpect(content().json("{\"error\":\"물건을 찾을 수 없습니다: id=999999\"}", true));
	}

	@Test
	void unexpectedFailureIs500WithoutLeakingTheCause() throws Exception {
		String body = mvc.perform(get("/stub/boom")).andExpect(status().isInternalServerError())
				.andExpect(jsonPath("$.error").isString()).andExpect(jsonPath("$.details").doesNotExist()).andReturn()
				.getResponse().getContentAsString();
		assertThat(body).doesNotContain("비밀");
	}

	@Test
	void springMvcStatusErrorsKeepTheirStatusAndUseTheErrorShape() throws Exception {
		mvc.perform(post("/stub/times")).andExpect(status().isMethodNotAllowed())
				.andExpect(jsonPath("$.error").isString());
		mvc.perform(get("/stub/nowhere")).andExpect(status().isNotFound()).andExpect(jsonPath("$.error").isString());
	}

}
