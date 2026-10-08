package com.auctionboss.item;

import static com.auctionboss.support.TestData.insertItem;
import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.util.ArrayList;
import java.util.List;

import com.auctionboss.support.AbstractMySqlTest;
import com.auctionboss.support.FixedClockConfig;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.context.annotation.Import;
import org.springframework.test.web.servlet.MockMvc;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/**
 * 3.5: 필터 선택지. 중복 판단과 정렬은 문자 그대로(SQLite 바이트 비교와 같게)여야 한다. Next 저장소 테스트
 * ({@code repository.test.ts})와 같은 사례를 쓴다.
 */
@AutoConfigureMockMvc
@Import(FixedClockConfig.class)
class FilterOptionsApiTest extends AbstractMySqlTest {

	private static final JsonMapper JSON = JsonMapper.builder().build();

	@Autowired
	MockMvc mvc;

	private JsonNode options() throws Exception {
		var result = mvc.perform(get("/api/items/filter-options")).andExpect(status().isOk()).andReturn();
		return JSON.readTree(result.getResponse().getContentAsString());
	}

	private static List<String> list(JsonNode node) {
		List<String> out = new ArrayList<>();
		node.forEach(n -> out.add(n.asString()));
		return out;
	}

	@Test
	void emptyDataGivesFourEmptyArraysInOrder() throws Exception {
		JsonNode body = options();

		assertThat(body.propertyNames()).containsExactly("usageTypes", "sidoValues", "sigunguValues", "courtValues");
		for (String key : List.of("usageTypes", "sidoValues", "sigunguValues", "courtValues")) {
			assertThat(body.get(key).isArray()).isTrue();
			assertThat(body.get(key)).isEmpty();
		}
	}

	@Test
	void courtsAreComparedCharacterForCharacter() throws Exception {
		insertItem(jdbc, "A법원", "1", null, null);
		insertItem(jdbc, "a법원", "2", null, null);
		insertItem(jdbc, "A법원 ", "3", null, null); // 뒤쪽 공백만 다르다
		insertItem(jdbc, "", "4", null, null); // 빈 문자열도 하나의 값이다
		insertItem(jdbc, "A법원", "5", null, null); // 중복

		assertThat(list(options().get("courtValues"))).containsExactly("", "A법원", "A법원 ", "a법원");
	}

	@Test
	void sortsByCodePointNotByCollationOrUtf16() throws Exception {
		insertItem(jdbc, "😀법원", "1", null, null); // U+1F600
		insertItem(jdbc, "豈법원", "2", null, null);
		insertItem(jdbc, "한법원", "3", null, null);
		insertItem(jdbc, "Z법원", "4", null, null);

		assertThat(list(options().get("courtValues"))).containsExactly("Z법원", "한법원", "豈법원", "😀법원");
	}

	@Test
	void sidoAndSigunguSkipNullKeepEmptyAndDistinguishCaseAndTrailingSpace() throws Exception {
		insertItem(jdbc, "법원", "1", "서울특별시", "관악구");
		insertItem(jdbc, "법원", "2", "경기도", "관악구");
		insertItem(jdbc, "법원", "3", "Seoul", "a구");
		insertItem(jdbc, "법원", "4", "seoul", "A구");
		insertItem(jdbc, "법원", "5", "seoul ", "A구 ");
		insertItem(jdbc, "법원", "6", "", "");
		insertItem(jdbc, "법원", "7", null, null);

		JsonNode body = options();
		assertThat(list(body.get("sidoValues"))).containsExactly("", "Seoul", "seoul", "seoul ", "경기도", "서울특별시");
		assertThat(list(body.get("sigunguValues"))).containsExactly("", "A구", "A구 ", "a구", "관악구");
	}

	@Test
	void usageTypesAreSplitTokensLikeTheUsageTypesApi() throws Exception {
		jdbc.update("INSERT INTO items (court, case_no, item_no, usage_type, first_seen_at, last_seen_at) "
				+ "VALUES ('법원', '1', '1', '상가, 오피스텔,,근린시설', NOW(3), NOW(3))");
		jdbc.update("INSERT INTO items (court, case_no, item_no, usage_type, first_seen_at, last_seen_at) "
				+ "VALUES ('법원', '2', '1', '아파트', NOW(3), NOW(3))");

		assertThat(list(options().get("usageTypes"))).containsExactly("근린시설", "상가", "아파트", "오피스텔");
	}

}
