package com.auctionboss.bookmark;

import static com.auctionboss.support.TestData.item;
import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.time.Instant;
import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.List;

import com.auctionboss.history.ChangeKind;
import com.auctionboss.history.ItemChange;
import com.auctionboss.history.ItemChangeRepository;
import com.auctionboss.item.AuctionSchedule;
import com.auctionboss.item.Item;
import com.auctionboss.item.ItemRepository;
import com.auctionboss.item.Location;
import com.auctionboss.support.AbstractMySqlTest;
import com.auctionboss.support.FixedClockConfig;
import com.auctionboss.support.MutableClock;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.context.annotation.Import;
import org.springframework.http.MediaType;
import org.springframework.test.context.TestPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/** 4.2 ~ 4.4: 관심 등록·해제·목록. */
@AutoConfigureMockMvc
@Import(FixedClockConfig.class)
@TestPropertySource(properties = "auctionboss.analysis.reanalysis-cooldown-hours=24")
class BookmarkApiTest extends AbstractMySqlTest {

	private static final JsonMapper JSON = JsonMapper.builder().build();

	private static final Instant T0 = Instant.parse("2026-10-08T00:00:00Z");

	@Autowired
	MockMvc mvc;
	@Autowired
	ItemRepository items;
	@Autowired
	ItemChangeRepository changes;
	@Autowired
	MutableClock clock;

	private int seq = 0;

	@BeforeEach
	void resetClock() {
		clock.set(T0);
	}

	private Item save() {
		int n = ++seq;
		return items.save(item("2026타경" + n, "1").usageType("아파트")
				.location(new Location("서울 " + n + "번지", null, null, null, null, null, null, null, null, null))
				.schedule(new AuctionSchedule(java.time.LocalDate.parse("2026-11-01").plusDays(n), null, null, null, null))
				.build());
	}

	private JsonNode perform(MockHttpServletRequestBuilder request, int expectedStatus) throws Exception {
		var result = mvc.perform(request).andExpect(status().is(expectedStatus)).andReturn();
		return JSON.readTree(result.getResponse().getContentAsString());
	}

	private JsonNode add(long itemId) throws Exception {
		return perform(post("/api/bookmarks").contentType(MediaType.APPLICATION_JSON)
				.content("{\"itemId\":" + itemId + "}"), 201);
	}

	private long bookmarkRows() {
		return jdbc.queryForObject("SELECT COUNT(*) FROM bookmarks", Long.class);
	}

	// ---- 4.2 등록 ----

	@Test
	void addRespondsWithTheBookmarkedItemInTheSameShapeAsTheDetailApi() throws Exception {
		Item it = save();
		changes.save(new ItemChange(it, "minBidPrice", "100", "90", Instant.parse("2026-10-01T00:00:00Z"),
				ChangeKind.CHANGE));

		JsonNode added = add(it.getId());

		assertThat(added.propertyNames()).containsExactly("item");
		assertThat(added.get("item").get("id").asLong()).isEqualTo(it.getId());
		assertThat(added.get("item").get("bookmarked").asBoolean()).isTrue();
		assertThat(added.get("item").get("lastChangedAt").asString()).isEqualTo("2026-10-01T00:00:00.000Z");
		JsonNode detail = perform(get("/api/items/" + it.getId()), 200);
		assertThat(added.get("item")).isEqualTo(detail.get("item"));
	}

	@Test
	void addingTwiceKeepsOneRowAndTheFirstCreatedAt() throws Exception {
		Item it = save();
		clock.set(Instant.parse("2026-10-08T00:00:01.250Z"));
		add(it.getId());
		LocalDateTime first = jdbc.queryForObject("SELECT created_at FROM bookmarks WHERE item_id = ?",
				LocalDateTime.class, it.getId());
		assertThat(first).isEqualTo(LocalDateTime.parse("2026-10-08T00:00:01.250"));

		clock.set(Instant.parse("2026-10-08T05:00:00Z"));
		JsonNode again = add(it.getId());

		assertThat(again.get("item").get("bookmarked").asBoolean()).isTrue();
		assertThat(bookmarkRows()).isEqualTo(1);
		assertThat(jdbc.queryForObject("SELECT created_at FROM bookmarks WHERE item_id = ?", LocalDateTime.class,
				it.getId())).isEqualTo(first);
	}

	@Test
	void addingAnUnknownItemIsNotFoundAndChangesNothing() throws Exception {
		Item it = save();
		add(it.getId());
		long missing = it.getId() + 1000;

		JsonNode error = perform(post("/api/bookmarks").content("{\"itemId\":" + missing + "}"), 404);

		assertThat(error.get("error").asString()).isEqualTo("물건을 찾을 수 없습니다: id=" + missing);
		assertThat(bookmarkRows()).isEqualTo(1);
	}

	@Test
	void addRejectsBadBodiesWithFieldDetails() throws Exception {
		Item it = save();
		for (String body : List.of("{\"itemId\":\"" + it.getId() + "\"}", "{\"itemId\":0}", "{\"itemId\":-3}",
				"{\"itemId\":1.5}", "{\"itemId\":null}", "{}")) {
			JsonNode error = perform(post("/api/bookmarks").content(body), 400);
			assertThat(error.get("error").asString()).as(body).isEqualTo("잘못된 관심 등록 본문입니다");
			assertThat(error.get("details").get(0).get("field").asString()).as(body).isEqualTo("itemId");
		}
		JsonNode array = perform(post("/api/bookmarks").content("[]"), 400);
		assertThat(array.get("details").get(0).get("field").asString()).isEqualTo("(root)");
		JsonNode garbage = perform(post("/api/bookmarks").content("이건 JSON이 아니다"), 400);
		assertThat(garbage.get("error").asString()).isEqualTo("JSON 본문을 해석할 수 없습니다");
		assertThat(garbage.has("details")).isFalse();
		perform(post("/api/bookmarks"), 400);
		assertThat(bookmarkRows()).isZero();
	}

	@Test
	void addIgnoresUnknownKeysAndContentType() throws Exception {
		Item it = save();

		perform(post("/api/bookmarks").contentType(MediaType.TEXT_PLAIN)
				.content("{\"itemId\":" + it.getId() + ".0,\"extra\":true}"), 201);

		assertThat(bookmarkRows()).isEqualTo(1);
	}

	// ---- 4.3 해제 ----

	@Test
	void removeRespondsWithBookmarkedFalseAndDropsTheItemFromBothViews() throws Exception {
		Item it = save();
		add(it.getId());
		mvc.perform(get("/api/items?bookmarked=true")).andExpect(jsonPath("$.total").value(1));

		JsonNode removed = perform(delete("/api/bookmarks/" + it.getId()), 200);

		assertThat(removed.propertyNames()).containsExactly("itemId", "bookmarked");
		assertThat(removed.get("itemId").asLong()).isEqualTo(it.getId());
		assertThat(removed.get("bookmarked").asBoolean()).isFalse();
		mvc.perform(get("/api/bookmarks")).andExpect(jsonPath("$.total").value(0));
		mvc.perform(get("/api/items?bookmarked=true")).andExpect(jsonPath("$.total").value(0));
	}

	@Test
	void removingAnItemThatIsNotBookmarkedStillSucceeds() throws Exception {
		Item it = save();

		JsonNode removed = perform(delete("/api/bookmarks/" + it.getId()), 200);

		assertThat(removed.get("bookmarked").asBoolean()).isFalse();
	}

	@Test
	void removingUnknownOrNonNumericIdsIsNotFound() throws Exception {
		Item it = save();
		add(it.getId());

		JsonNode missing = perform(delete("/api/bookmarks/" + (it.getId() + 1000)), 404);
		assertThat(missing.get("error").asString()).isEqualTo("물건을 찾을 수 없습니다: id=" + (it.getId() + 1000));
		JsonNode text = perform(delete("/api/bookmarks/abc"), 404);
		assertThat(text.get("error").asString()).isEqualTo("물건을 찾을 수 없습니다: id=abc");
		perform(delete("/api/bookmarks/99999999999999999999"), 404);
		perform(delete("/api/bookmarks/-1"), 404);

		assertThat(bookmarkRows()).isEqualTo(1);
	}

	// ---- 4.4 목록 ----

	@Test
	void emptyBookmarkListIsNotAnError() throws Exception {
		JsonNode list = perform(get("/api/bookmarks"), 200);

		assertThat(list.propertyNames()).containsExactly("items", "total", "page", "pageSize");
		assertThat(list.get("items")).isEmpty();
		assertThat(list.get("total").asInt()).isZero();
		assertThat(list.get("page").asInt()).isEqualTo(1);
		assertThat(list.get("pageSize").asInt()).isEqualTo(20);
	}

	@Test
	void listIsMostRecentlyBookmarkedFirstWithItemIdDescendingTieBreak() throws Exception {
		Item a = save();
		Item b = save();
		Item c = save();
		Item d = save();
		clock.set(T0.plusSeconds(1));
		add(b.getId());
		clock.set(T0.plusSeconds(2));
		add(a.getId());
		clock.set(T0.plusSeconds(3));
		add(c.getId());
		add(d.getId()); // c와 같은 담은 시각: 물건 id가 큰 d가 먼저다.

		JsonNode list = perform(get("/api/bookmarks"), 200);

		assertThat(itemIds(list)).containsExactly(d.getId(), c.getId(), a.getId(), b.getId());
		assertThat(list.get("total").asInt()).isEqualTo(4);
	}

	@Test
	void eachListedItemIsTheSameJsonAsTheDetailApiItem() throws Exception {
		Item a = save();
		Item b = save();
		changes.save(new ItemChange(a, "status", "진행", "취소", Instant.parse("2026-10-02T03:04:05.006Z"),
				ChangeKind.CHANGE));
		changes.save(new ItemChange(a, "status", null, "진행", Instant.parse("2026-09-01T00:00:00Z"), ChangeKind.BASELINE));
		add(a.getId());
		clock.set(T0.plusSeconds(1));
		add(b.getId());

		JsonNode list = perform(get("/api/bookmarks"), 200);

		assertThat(list.get("items")).hasSize(2);
		for (JsonNode listed : list.get("items")) {
			JsonNode detail = perform(get("/api/items/" + listed.get("id").asLong()), 200);
			assertThat(listed).isEqualTo(detail.get("item"));
			assertThat(listed.get("bookmarked").asBoolean()).isTrue();
		}
		assertThat(list.get("items").get(1).get("lastChangedAt").asString()).isEqualTo("2026-10-02T03:04:05.006Z");
		assertThat(list.get("items").get(0).get("lastChangedAt").isNull()).isTrue();
	}

	@Test
	void pagingAndBadParameters() throws Exception {
		List<Item> saved = new ArrayList<>();
		for (int i = 0; i < 3; i++) {
			Item it = save();
			saved.add(it);
			clock.set(T0.plusSeconds(i + 1));
			add(it.getId());
		}

		JsonNode page2 = perform(get("/api/bookmarks?pageSize=2&page=2"), 200);
		assertThat(itemIds(page2)).containsExactly(saved.get(0).getId());
		assertThat(page2.get("total").asInt()).isEqualTo(3);
		assertThat(page2.get("page").asInt()).isEqualTo(2);
		assertThat(page2.get("pageSize").asInt()).isEqualTo(2);
		assertThat(itemIds(perform(get("/api/bookmarks?page=99999999999999"), 200))).isEmpty();

		JsonNode error = perform(get("/api/bookmarks?page=0&pageSize=500"), 400);
		assertThat(error.get("error").asString()).isEqualTo("잘못된 요청 파라미터입니다");
		assertThat(error.get("details").get(0).get("field").asString()).isEqualTo("page");
		assertThat(error.get("details").get(1).get("field").asString()).isEqualTo("pageSize");
	}

	private static List<Long> itemIds(JsonNode list) {
		List<Long> ids = new ArrayList<>();
		list.get("items").forEach(n -> ids.add(n.get("id").asLong()));
		return ids;
	}

}
