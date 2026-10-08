package com.auctionboss.bookmark;

import static com.auctionboss.support.TestData.item;
import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.time.Instant;
import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.List;

import com.auctionboss.history.ChangeKind;
import com.auctionboss.history.ItemChange;
import com.auctionboss.history.ItemChangeRepository;
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
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/** 4.5: 변동 피드와 읽음 처리. */
@AutoConfigureMockMvc
@Import(FixedClockConfig.class)
class FeedApiTest extends AbstractMySqlTest {

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
		return items.save(item("2026타경" + n, "1")
				.location(new Location("서울 " + n + "번지", null, null, null, null, null, null, null, null, null))
				.build());
	}

	private ItemChange change(Item it, String field, String at, ChangeKind kind) {
		return changes.save(new ItemChange(it, field, "a", "b", Instant.parse(at), kind));
	}

	private JsonNode perform(MockHttpServletRequestBuilder request, int expectedStatus) throws Exception {
		var result = mvc.perform(request).andExpect(status().is(expectedStatus)).andReturn();
		return JSON.readTree(result.getResponse().getContentAsString());
	}

	private void bookmark(Item it) throws Exception {
		perform(post("/api/bookmarks").content("{\"itemId\":" + it.getId() + "}"), 201);
	}

	private JsonNode feed(String query) throws Exception {
		return perform(get("/api/feed" + query), 200);
	}

	private long feedReadRows() {
		return jdbc.queryForObject("SELECT COUNT(*) FROM feed_reads", Long.class);
	}

	private static List<Long> entryIds(JsonNode feed) {
		List<Long> ids = new ArrayList<>();
		feed.get("entries").forEach(n -> ids.add(n.get("id").asLong()));
		return ids;
	}

	@Test
	void feedContainsOnlyRealChangesOfBookmarkedItemsNewestFirstWithUnreadCountEqualToTotal() throws Exception {
		Item a = save();
		Item other = save();
		ItemChange baseline = change(a, "status", "2026-09-01T00:00:00Z", ChangeKind.BASELINE);
		ItemChange old = change(a, "minBidPrice", "2026-09-10T00:00:00Z", ChangeKind.CHANGE);
		ItemChange newer = change(a, "status", "2026-09-20T00:00:00Z", ChangeKind.CHANGE);
		ItemChange sameTime = change(a, "auctionDate", "2026-09-20T00:00:00Z", ChangeKind.CHANGE);
		change(other, "status", "2026-09-25T00:00:00Z", ChangeKind.CHANGE);
		clock.set(T0.plusSeconds(5));
		bookmark(a);

		JsonNode feed = feed("");

		assertThat(feed.propertyNames()).containsExactly("entries", "total", "page", "pageSize", "unreadCount");
		// 기준점 제외, 다른 물건 제외. 같은 변경 시각이면 변경 id 내림차순.
		assertThat(entryIds(feed)).containsExactly(sameTime.getId(), newer.getId(), old.getId());
		assertThat(entryIds(feed)).doesNotContain(baseline.getId());
		assertThat(feed.get("total").asInt()).isEqualTo(3);
		assertThat(feed.get("unreadCount").asInt()).isEqualTo(3);
		JsonNode first = feed.get("entries").get(0);
		assertThat(first.propertyNames()).containsExactly("id", "itemId", "itemAddress", "field", "oldValue",
				"newValue", "changedAt", "bookmarkedAt");
		assertThat(first.get("itemId").asLong()).isEqualTo(a.getId());
		assertThat(first.get("itemAddress").asString()).isEqualTo("서울 1번지");
		assertThat(first.get("field").asString()).isEqualTo("auctionDate");
		assertThat(first.get("oldValue").asString()).isEqualTo("a");
		assertThat(first.get("newValue").asString()).isEqualTo("b");
		assertThat(first.get("changedAt").asString()).isEqualTo("2026-09-20T00:00:00.000Z");
		assertThat(first.get("bookmarkedAt").asString()).isEqualTo("2026-10-08T00:00:05.000Z");
	}

	@Test
	void sinceBookmarkedAtKeepsOnlyChangesAfterTheBookmarkTimeStrictly() throws Exception {
		Item a = save();
		change(a, "status", "2026-10-08T00:00:00Z", ChangeKind.CHANGE); // 담기 전
		ItemChange exactly = change(a, "minBidPrice", "2026-10-08T00:00:10Z", ChangeKind.CHANGE); // 담은 시각과 같음
		ItemChange later = change(a, "auctionDate", "2026-10-08T00:00:20Z", ChangeKind.CHANGE);
		clock.set(Instant.parse("2026-10-08T00:00:10Z"));
		bookmark(a);

		assertThat(feed("").get("total").asInt()).isEqualTo(3);
		JsonNode since = feed("?sinceBookmarkedAt=true");
		assertThat(entryIds(since)).containsExactly(later.getId());
		assertThat(since.get("total").asInt()).isEqualTo(1);
		assertThat(exactly.getId()).isNotNull();
		assertThat(feed("?sinceBookmarkedAt=false").get("total").asInt()).isEqualTo(3);
		// unreadCount는 sinceBookmarkedAt과 무관하게 전체 피드 기준이다.
		assertThat(since.get("unreadCount").asInt()).isEqualTo(3);
	}

	@Test
	void unbookmarkedItemsLeaveTheFeedAndTheUnreadCount() throws Exception {
		Item a = save();
		change(a, "status", "2026-09-10T00:00:00Z", ChangeKind.CHANGE);
		bookmark(a);
		assertThat(feed("").get("total").asInt()).isEqualTo(1);

		perform(delete("/api/bookmarks/" + a.getId()), 200);

		JsonNode after = feed("");
		assertThat(after.get("entries")).isEmpty();
		assertThat(after.get("unreadCount").asInt()).isZero();
	}

	@Test
	void markReadRecordsServerTimeAndResetsTheUnreadCount() throws Exception {
		Item a = save();
		change(a, "status", "2026-09-10T00:00:00Z", ChangeKind.CHANGE);
		bookmark(a);
		clock.set(Instant.parse("2026-10-08T03:04:05.678912Z"));

		JsonNode read = perform(post("/api/feed/read"), 200);

		assertThat(read.propertyNames()).containsExactly("lastReadAt", "unreadCount");
		assertThat(read.get("lastReadAt").asString()).isEqualTo("2026-10-08T03:04:05.678Z");
		assertThat(read.get("unreadCount").asInt()).isZero();
		assertThat(jdbc.queryForObject("SELECT last_read_at FROM feed_reads WHERE id = 1", LocalDateTime.class))
				.isEqualTo(LocalDateTime.parse("2026-10-08T03:04:05.678"));
		assertThat(feed("").get("unreadCount").asInt()).isZero();
		assertThat(feed("").get("total").asInt()).isEqualTo(1);
	}

	@Test
	void changesAfterTheLastReadAreUnreadAndTheBoundaryIsStrict() throws Exception {
		Item a = save();
		bookmark(a);
		clock.set(Instant.parse("2026-10-08T01:00:00Z"));
		perform(post("/api/feed/read"), 200);
		change(a, "status", "2026-10-08T01:00:00Z", ChangeKind.CHANGE); // 읽은 시각과 같음: 미확인 아님
		assertThat(feed("").get("unreadCount").asInt()).isZero();

		change(a, "minBidPrice", "2026-10-08T01:00:00.001Z", ChangeKind.CHANGE);
		change(a, "auctionDate", "2026-10-08T02:00:00Z", ChangeKind.BASELINE); // 기준점은 세지 않는다

		JsonNode feed = feed("");
		assertThat(feed.get("unreadCount").asInt()).isEqualTo(1);
		assertThat(feed.get("total").asInt()).isEqualTo(2);
	}

	@Test
	void readingTheFeedNeverMarksItReadAndKeepsTheLastReadAtRowUntouched() throws Exception {
		Item a = save();
		change(a, "status", "2026-09-10T00:00:00Z", ChangeKind.CHANGE);
		bookmark(a);

		JsonNode first = feed("");
		JsonNode second = feed("");

		assertThat(first.get("unreadCount").asInt()).isEqualTo(1);
		assertThat(second.get("unreadCount").asInt()).isEqualTo(1);
		assertThat(feedReadRows()).isZero();

		perform(post("/api/feed/read"), 200);
		LocalDateTime firstRead = jdbc.queryForObject("SELECT last_read_at FROM feed_reads", LocalDateTime.class);
		feed("");
		assertThat(jdbc.queryForObject("SELECT last_read_at FROM feed_reads", LocalDateTime.class)).isEqualTo(firstRead);
	}

	@Test
	void feedReadsAlwaysKeepASingleRowAndLaterReadsOverwriteTheTime() throws Exception {
		clock.set(Instant.parse("2026-10-08T01:00:00Z"));
		perform(post("/api/feed/read"), 200);
		clock.set(Instant.parse("2026-10-08T02:00:00Z"));
		JsonNode second = perform(post("/api/feed/read"), 200);
		perform(post("/api/feed/read").content("garbage").contentType("application/json"), 200);

		assertThat(feedReadRows()).isEqualTo(1);
		assertThat(second.get("lastReadAt").asString()).isEqualTo("2026-10-08T02:00:00.000Z");
		assertThat(jdbc.queryForObject("SELECT id FROM feed_reads", Integer.class)).isEqualTo(1);
		assertThat(jdbc.queryForObject("SELECT last_read_at FROM feed_reads", LocalDateTime.class))
				.isEqualTo(LocalDateTime.parse("2026-10-08T02:00:00"));
	}

	@Test
	void emptyFeedIsNotAnErrorAndPagingWorks() throws Exception {
		JsonNode empty = feed("");
		assertThat(empty.get("entries")).isEmpty();
		assertThat(empty.get("total").asInt()).isZero();
		assertThat(empty.get("unreadCount").asInt()).isZero();
		assertThat(empty.get("pageSize").asInt()).isEqualTo(20);

		Item a = save();
		bookmark(a);
		ItemChange c1 = change(a, "status", "2026-09-01T00:00:00Z", ChangeKind.CHANGE);
		ItemChange c2 = change(a, "status", "2026-09-02T00:00:00Z", ChangeKind.CHANGE);
		ItemChange c3 = change(a, "status", "2026-09-03T00:00:00Z", ChangeKind.CHANGE);

		JsonNode page2 = feed("?pageSize=2&page=2");
		assertThat(entryIds(page2)).containsExactly(c1.getId());
		assertThat(page2.get("total").asInt()).isEqualTo(3);
		assertThat(entryIds(feed("?pageSize=2"))).containsExactly(c3.getId(), c2.getId());
		assertThat(entryIds(feed("?page=99999999999999"))).isEmpty();
	}

	@Test
	void badParametersAreRejectedWithTheirFieldNames() throws Exception {
		JsonNode error = perform(get("/api/feed?sinceBookmarkedAt=yes"), 400);

		assertThat(error.get("error").asString()).isEqualTo("잘못된 요청 파라미터입니다");
		assertThat(error.get("details").get(0).get("field").asString()).isEqualTo("sinceBookmarkedAt");
		JsonNode page = perform(get("/api/feed?page=0"), 400);
		assertThat(page.get("details").get(0).get("field").asString()).isEqualTo("page");
	}

}
