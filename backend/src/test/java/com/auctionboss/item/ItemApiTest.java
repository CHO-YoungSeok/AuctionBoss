package com.auctionboss.item;

import static com.auctionboss.support.TestData.item;
import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.time.Instant;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.List;

import com.auctionboss.analysis.Analysis;
import com.auctionboss.analysis.AnalysisRepository;
import com.auctionboss.bookmark.Bookmark;
import com.auctionboss.history.ChangeKind;
import com.auctionboss.history.ItemChange;
import com.auctionboss.history.ItemChangeRepository;
import com.auctionboss.support.AbstractMySqlTest;
import com.auctionboss.support.FixedClockConfig;
import jakarta.persistence.EntityManager;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.context.annotation.Import;
import org.springframework.test.context.TestPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.transaction.support.TransactionTemplate;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/** 5.5: 물건 API(목록, 상세, 변경 이력, 용도 목록). 키 이름, 시각 형식, 오류 형태를 MockMvc로 확인한다. */
@AutoConfigureMockMvc
@Import(FixedClockConfig.class)
@TestPropertySource(properties = "auctionboss.analysis.reanalysis-cooldown-hours=24")
class ItemApiTest extends AbstractMySqlTest {

	private static final JsonMapper JSON = JsonMapper.builder().build();

	@Autowired
	MockMvc mvc;
	@Autowired
	ItemRepository items;
	@Autowired
	AnalysisRepository analyses;
	@Autowired
	ItemChangeRepository changes;
	@Autowired
	EntityManager em;
	@Autowired
	TransactionTemplate tx;

	private int seq = 0;

	private Item save(String usage, String date) {
		Item.Builder b = item("2026타경" + (++seq), "1").usageType(usage);
		if (date != null) {
			b.schedule(new AuctionSchedule(LocalDate.parse(date), null, null, null, null));
		}
		return items.save(b.build());
	}

	private JsonNode getJson(String url) throws Exception {
		return JSON.readTree(mvc.perform(get(url)).andReturn().getResponse().getContentAsString());
	}

	@Test
	void listUsesDefaultsAndSortsByAuctionDateAscending() throws Exception {
		Item late = save("아파트", "2026-11-02");
		Item early = save("아파트", "2026-11-01");

		mvc.perform(get("/api/items")).andExpect(status().isOk()).andExpect(jsonPath("$.total").value(2))
				.andExpect(jsonPath("$.page").value(1)).andExpect(jsonPath("$.pageSize").value(20))
				.andExpect(jsonPath("$.items[0].id").value(early.getId()))
				.andExpect(jsonPath("$.items[1].id").value(late.getId()))
				.andExpect(jsonPath("$.items[0].auctionDate").value("2026-11-01"))
				.andExpect(jsonPath("$.items[0].firstSeenAt").value("2026-09-08T11:48:38.617Z"))
				.andExpect(jsonPath("$.items[0].bookmarked").value(false))
				.andExpect(jsonPath("$.items[0].lastChangedAt").value(org.hamcrest.Matchers.nullValue()));
		List<String> keys = new ArrayList<>();
		getJson("/api/items").propertyNames().forEach(keys::add);
		assertThat(keys).containsExactly("items", "total", "page", "pageSize");
	}

	@Test
	void listAppliesAFilter() throws Exception {
		save("아파트", "2026-11-01");
		Item office = save("오피스텔", "2026-11-02");

		mvc.perform(get("/api/items").param("usage", "오피스텔")).andExpect(status().isOk())
				.andExpect(jsonPath("$.total").value(1)).andExpect(jsonPath("$.items[0].id").value(office.getId()));
	}

	@Test
	void invalidSortIs400WithFieldDetail() throws Exception {
		mvc.perform(get("/api/items").param("sort", "nope")).andExpect(status().isBadRequest())
				.andExpect(jsonPath("$.error").value("잘못된 요청 파라미터입니다"))
				.andExpect(jsonPath("$.details[0].field").value("sort"))
				.andExpect(jsonPath("$.details[0].message").isString());
	}

	@Test
	void detailWithAnalysisReturnsItemAndLatestAnalysis() throws Exception {
		Item it = save("아파트", "2026-11-01");
		analyses.save(new Analysis(it, "이전 본문", "model-a", "v1", Instant.parse("2026-09-01T00:00:00Z")));
		analyses.save(new Analysis(it, "최신 본문", null, "v2", Instant.parse("2026-09-02T00:00:00.5Z")));
		items.flush();
		tx.executeWithoutResult(s -> em.persist(new Bookmark(it.getId(), Instant.parse("2026-09-03T00:00:00Z"))));

		String body = mvc.perform(get("/api/items/" + it.getId())).andExpect(status().isOk())
				.andExpect(jsonPath("$.item.id").value(it.getId())).andExpect(jsonPath("$.item.bookmarked").value(true))
				.andExpect(jsonPath("$.analysis.body").value("최신 본문"))
				.andExpect(jsonPath("$.analysis.itemId").value(it.getId()))
				.andExpect(jsonPath("$.analysis.model").value(org.hamcrest.Matchers.nullValue()))
				.andExpect(jsonPath("$.analysis.promptVersion").value("v2"))
				.andExpect(jsonPath("$.analysis.analyzedAt").value("2026-09-02T00:00:00.500Z")).andReturn()
				.getResponse().getContentAsString();
		JsonNode node = JSON.readTree(body);
		List<String> keys = new ArrayList<>();
		node.propertyNames().forEach(keys::add);
		assertThat(keys).containsExactly("item", "analysis");
		keys.clear();
		node.get("analysis").propertyNames().forEach(keys::add);
		assertThat(keys).containsExactly("id", "itemId", "body", "model", "promptVersion", "analyzedAt");
		assertThat(node.get("analysis").get("model").isNull()).isTrue();
	}

	@Test
	void detailWithoutAnalysisHasNullAnalysisAndNullLastChangedAt() throws Exception {
		Item it = save("아파트", "2026-11-01");

		mvc.perform(get("/api/items/" + it.getId())).andExpect(status().isOk())
				.andExpect(jsonPath("$.item.id").value(it.getId()))
				.andExpect(jsonPath("$.item.bookmarked").value(false));
		JsonNode node = getJson("/api/items/" + it.getId());
		assertThat(node.get("analysis").isNull()).isTrue();
		assertThat(node.get("item").get("lastChangedAt").isNull()).isTrue();
	}

	@Test
	void notFoundForNonNumericAndMissingIds() throws Exception {
		mvc.perform(get("/api/items/abc")).andExpect(status().isNotFound())
				.andExpect(content().json("{\"error\":\"물건을 찾을 수 없습니다: id=abc\"}", true));
		mvc.perform(get("/api/items/999999")).andExpect(status().isNotFound())
				.andExpect(content().json("{\"error\":\"물건을 찾을 수 없습니다: id=999999\"}", true));
		mvc.perform(get("/api/items/99999999999999999999999")).andExpect(status().isNotFound());
		mvc.perform(get("/api/items/abc/changes")).andExpect(status().isNotFound())
				.andExpect(jsonPath("$.error").value("물건을 찾을 수 없습니다: id=abc"));
		mvc.perform(get("/api/items/999999/changes")).andExpect(status().isNotFound());
	}

	/** 원본은 ^\\d+$ 검사다. Long.parseLong만 쓰면 "+id"가 통과해 존재하는 물건이 200으로 열린다. */
	@Test
	void signedIdIsNotFoundEvenWhenTheNumberExists() throws Exception {
		Item it = save("아파트", "2026-11-01");

		mvc.perform(get("/api/items/+" + it.getId())).andExpect(status().isNotFound());
		mvc.perform(get("/api/items/+" + it.getId() + "/changes")).andExpect(status().isNotFound());
		mvc.perform(get("/api/items/" + it.getId())).andExpect(status().isOk());
	}

	@Test
	void changesAreOrderedByTimeThenIdWithOriginalFields() throws Exception {
		Item it = save("아파트", "2026-11-01");
		Instant t1 = Instant.parse("2026-09-01T00:00:00Z");
		Instant t2 = Instant.parse("2026-09-02T00:00:00.250Z");
		changes.save(new ItemChange(it, "minBidPrice", "100", "90", t2, ChangeKind.CHANGE));
		changes.save(new ItemChange(it, "status", null, "진행", t1, ChangeKind.BASELINE));

		String body = mvc.perform(get("/api/items/" + it.getId() + "/changes")).andExpect(status().isOk())
				.andExpect(jsonPath("$.changes.length()").value(2))
				.andExpect(jsonPath("$.changes[0].field").value("status"))
				.andExpect(jsonPath("$.changes[0].kind").value("baseline"))
				.andExpect(jsonPath("$.changes[0].changedAt").value("2026-09-01T00:00:00.000Z"))
				.andExpect(jsonPath("$.changes[1].field").value("minBidPrice"))
				.andExpect(jsonPath("$.changes[1].oldValue").value("100"))
				.andExpect(jsonPath("$.changes[1].newValue").value("90"))
				.andExpect(jsonPath("$.changes[1].kind").value("change"))
				.andExpect(jsonPath("$.changes[1].changedAt").value("2026-09-02T00:00:00.250Z")).andReturn()
				.getResponse().getContentAsString();
		List<String> keys = new ArrayList<>();
		JSON.readTree(body).get("changes").get(0).propertyNames().forEach(keys::add);
		assertThat(keys).containsExactly("id", "itemId", "field", "oldValue", "newValue", "changedAt", "kind");
		assertThat(JSON.readTree(body).get("changes").get(0).get("oldValue").isNull()).isTrue();
	}

	@Test
	void changesOfItemWithoutHistoryIsEmptyArray() throws Exception {
		Item it = save("아파트", "2026-11-01");
		mvc.perform(get("/api/items/" + it.getId() + "/changes")).andExpect(status().isOk())
				.andExpect(content().json("{\"changes\":[]}", true));
	}

	@Test
	void usageTypesIsEmptyWithoutItemsAndNotCapturedByIdPattern() throws Exception {
		mvc.perform(get("/api/items/usage-types")).andExpect(status().isOk())
				.andExpect(content().json("{\"usageTypes\":[]}", true));

		save("아파트, 오피스텔", null);
		save("아파트", null);
		mvc.perform(get("/api/items/usage-types")).andExpect(status().isOk())
				.andExpect(jsonPath("$.usageTypes[0]").value("아파트"))
				.andExpect(jsonPath("$.usageTypes[1]").value("오피스텔"))
				.andExpect(jsonPath("$.usageTypes.length()").value(2));
	}

}
