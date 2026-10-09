package com.auctionboss.collect.collector;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.time.LocalDateTime;
import java.time.ZoneOffset;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import com.auctionboss.collect.source.SourceItem;
import com.auctionboss.support.AbstractMySqlTest;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;

/** 3.1·3.2: 저장과 변경 이력 (design D8·D9). 실제 MySQL(Testcontainers) 위에서 돈다. */
class ItemUpsertServiceTest extends AbstractMySqlTest {

	private static final Instant T0 = Instant.parse("2026-10-08T00:00:00.000Z");

	private static final Instant T1 = Instant.parse("2026-10-08T00:10:00.000Z");

	@Autowired
	ItemUpsertService service;

	@BeforeEach
	void resetCounters() {
		jdbc.update("ALTER TABLE items AUTO_INCREMENT = 1");
		jdbc.update("ALTER TABLE item_changes AUTO_INCREMENT = 1");
	}

	@AfterEach
	void dropInjectedConstraint() {
		try {
			jdbc.execute("ALTER TABLE item_changes DROP CHECK ck_inject");
		}
		catch (RuntimeException ignored) {
			// 주입하지 않은 테스트
		}
	}

	private static LocalDateTime at(Instant t) {
		return LocalDateTime.ofInstant(t, ZoneOffset.UTC);
	}

	private List<Map<String, Object>> changes() {
		return jdbc.queryForList(
				"SELECT item_id, field, old_value, new_value, kind, changed_at FROM item_changes ORDER BY id");
	}

	private Map<String, Object> itemRow(String caseNo) {
		return jdbc.queryForMap("SELECT * FROM items WHERE case_no = ?", caseNo);
	}

	@Test
	void 신규는_값이_있는_감시_필드마다_기준점을_남긴다() {
		UpsertResult r = service.upsertItems(List.of(TestItems.item("A", 100L, 0L, "2026-11-05", "신건"),
				TestItems.item("B", 200L, 1L, null, "유찰 1회")), T0);

		assertThat(r).isEqualTo(new UpsertResult(2, 0, 0));
		assertThat(changes()).hasSize(7); // A 4개 + B 3개(매각기일 없음)
		assertThat(changes()).allMatch(c -> "baseline".equals(c.get("kind")) && c.get("old_value") == null);
		assertThat(changes()).noneMatch(c -> c.get("item_id").equals(itemRow("B").get("id")) && "auctionDate".equals(c.get("field")));
	}

	@Test
	void 갱신은_바뀐_감시_필드만_변경으로_남기고_first_seen_at을_보존한다() {
		service.upsertItems(List.of(TestItems.item("A", 100L, 0L, "2026-11-05", "신건")), T0);
		UpsertResult r = service.upsertItems(List.of(TestItems.item("A", 90L, 1L, "2026-11-05", "신건")), T1);

		assertThat(r).isEqualTo(new UpsertResult(0, 1, 1));
		List<Map<String, Object>> changes = changes().stream().filter(c -> "change".equals(c.get("kind"))).toList();
		assertThat(changes).extracting(c -> c.get("field")).containsExactly("minBidPrice", "failedBidCount");
		assertThat(changes.get(0)).containsEntry("old_value", "100").containsEntry("new_value", "90");
		Map<String, Object> row = itemRow("A");
		assertThat(row.get("first_seen_at")).isEqualTo(at(T0));
		assertThat(row.get("last_seen_at")).isEqualTo(at(T1));
		assertThat(row.get("min_bid_price")).isEqualTo(90L);
	}

	@Test
	void 감시_대상이_아닌_필드만_바뀌면_이력도_changed도_없다() {
		SourceItem a = TestItems.item("A", 100L, 0L, "2026-11-05", "신건");
		service.upsertItems(List.of(a), T0);
		UpsertResult r = service.upsertItems(List.of(TestItems.withAddress(a, "다른 주소")), T1);

		assertThat(r).isEqualTo(new UpsertResult(0, 1, 0));
		assertThat(changes()).hasSize(4).allMatch(c -> "baseline".equals(c.get("kind")));
		assertThat(itemRow("A").get("address")).isEqualTo("다른 주소");
	}

	@Test
	void 값이_없던_필드에_값이_생기면_old_value_null의_change다() {
		service.upsertItems(List.of(TestItems.item("A", 100L, 0L, null, "신건")), T0);
		UpsertResult r = service.upsertItems(List.of(TestItems.item("A", 100L, 0L, "2026-11-05", "신건")), T1);

		assertThat(r).isEqualTo(new UpsertResult(0, 1, 1));
		Map<String, Object> last = changes().get(changes().size() - 1);
		assertThat(last).containsEntry("field", "auctionDate")
			.containsEntry("kind", "change")
			.containsEntry("new_value", "2026-11-05");
		assertThat(last.get("old_value")).isNull();
	}

	@Test
	void 값이_사라지면_new_value_null의_change다() {
		service.upsertItems(List.of(TestItems.item("A", 100L, 0L, "2026-11-05", "신건")), T0);
		service.upsertItems(List.of(TestItems.item("A", 100L, 0L, null, "신건")), T1);

		Map<String, Object> last = changes().get(changes().size() - 1);
		assertThat(last).containsEntry("field", "auctionDate").containsEntry("old_value", "2026-11-05");
		assertThat(last.get("new_value")).isNull();
		assertThat(last).containsEntry("kind", "change");
	}

	@Test
	void 그대로인_물건은_이력이_없고_갱신으로만_센다() {
		SourceItem a = TestItems.item("A", 100L, 0L, "2026-11-05", "신건");
		service.upsertItems(List.of(a), T0);
		UpsertResult r = service.upsertItems(List.of(a), T1);

		assertThat(r).isEqualTo(new UpsertResult(0, 1, 0));
		assertThat(changes()).hasSize(4);
	}

	@Test
	void 갱신도_자동증가_id를_한_칸_쓴다() {
		service.upsertItems(List.of(TestItems.item("A", 100L, 0L, null, "신건")), T0);
		service.upsertItems(List.of(TestItems.item("A", 90L, 0L, null, "신건")), T1);
		service.upsertItems(List.of(TestItems.item("B", 100L, 0L, null, "신건")), T1);

		// A 신규 id=1, A 갱신이 2를 쓰고, B는 3
		assertThat(itemRow("B").get("id")).isEqualTo(3L);
	}

	@Test
	void 같은_배치의_중복_키는_앞_처리_결과와_비교해_이력을_남기고_changed는_물건당_한_번이다() {
		// 기존 X, 배치 안에서 X가 두 번(1000 -> 900 -> 800), 신규 Y가 두 번(500 -> 400). 같은 키의 두 번째 행은 사전 SELECT에 보여 갱신으로 센다.
		service.upsertItems(List.of(TestItems.item("X", 1000L, 0L, "2026-11-05", "신건")), T0);
		int before = changes().size();

		UpsertResult r = service.upsertItems(List.of(TestItems.item("X", 900L, 1L, "2026-11-05", "신건"),
				TestItems.item("X", 800L, 1L, "2026-11-05", "신건"), TestItems.item("Y", 500L, 0L, null, "신건"),
				TestItems.item("Y", 400L, 0L, null, "신건")), T1);

		assertThat(r).isEqualTo(new UpsertResult(1, 3, 1));
		List<Map<String, Object>> added = changes().subList(before, changes().size());
		assertThat(added).extracting(c -> c.get("field") + ":" + c.get("old_value") + ">" + c.get("new_value") + ":"
				+ c.get("kind"))
			.containsExactly("minBidPrice:1000>900:change", "failedBidCount:0>1:change", "minBidPrice:900>800:change",
					"minBidPrice:null>500:baseline", "failedBidCount:null>0:baseline", "status:null>신건:baseline",
					"minBidPrice:500>400:change");
	}

	@Test
	void 배치_안에서_시작값으로_돌아오면_changed는_0이다() {
		service.upsertItems(List.of(TestItems.item("X", 1000L, 0L, null, "신건")), T0);
		UpsertResult r = service.upsertItems(List.of(TestItems.item("X", 900L, 0L, null, "신건"),
				TestItems.item("X", 1000L, 0L, null, "신건")), T1);
		assertThat(r).isEqualTo(new UpsertResult(0, 2, 0));
	}

	@Test
	void 오십억_넘는_금액도_그대로_저장하고_같은_값이면_변경이_아니다() {
		long big = 51_005_255_120L;
		service.upsertItems(List.of(TestItems.item("A", big, 0L, null, "신건")), T0);
		UpsertResult r = service.upsertItems(List.of(TestItems.item("A", big, 0L, null, "신건")), T1);
		assertThat(r.changed()).isZero();
		assertThat(itemRow("A").get("min_bid_price")).isEqualTo(big);
	}

	@Test
	void 이력_INSERT가_실패하면_물건_변경이_하나도_남지_않는다() {
		service.upsertItems(List.of(TestItems.item("A", 100L, 0L, null, "신건")), T0);
		int itemsBefore = jdbc.queryForObject("SELECT COUNT(*) FROM items", Integer.class);
		int changesBefore = changes().size();

		// 이력 행의 new_value가 777인 것만 실패시키는 CHECK 제약을 임시로 건다.
		jdbc.execute("ALTER TABLE item_changes ADD CONSTRAINT ck_inject CHECK (new_value IS NULL OR new_value <> '777')");


		List<SourceItem> batch = new ArrayList<>();
		batch.add(TestItems.item("A", 90L, 0L, null, "신건")); // 앞 물건: 정상 갱신 + 이력
		batch.add(TestItems.item("NEW", 500L, 0L, null, "신건")); // 신규
		batch.add(TestItems.item("A", 777L, 0L, null, "신건")); // 여기서 이력 INSERT 실패

		assertThatThrownBy(() -> service.upsertItems(batch, T1)).hasMessageContaining("ck_inject");

		assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM items", Integer.class)).isEqualTo(itemsBefore);
		assertThat(changes()).hasSize(changesBefore);
		Map<String, Object> a = itemRow("A");
		assertThat(a.get("min_bid_price")).isEqualTo(100L);
		assertThat(a.get("last_seen_at")).isEqualTo(at(T0));
	}

}
