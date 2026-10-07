package com.auctionboss.item;

import static com.auctionboss.support.TestData.T0;
import static com.auctionboss.support.TestData.item;
import static org.assertj.core.api.Assertions.assertThat;

import java.time.Instant;
import java.util.List;

import com.auctionboss.analysis.Analysis;
import com.auctionboss.analysis.AnalysisRepository;
import com.auctionboss.history.ChangeKind;
import com.auctionboss.history.ItemChange;
import com.auctionboss.history.ItemChangeRepository;
import com.auctionboss.photo.PhotoStatus;
import com.auctionboss.support.AbstractMySqlTest;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;

/** 3.3: 원본 repository.ts의 조회 규칙을 그대로 옮긴 저장소 동작 확인. */
class ItemQueryRepositoryTest extends AbstractMySqlTest {

	@Autowired
	ItemRepository items;
	@Autowired
	AnalysisRepository analyses;
	@Autowired
	ItemChangeRepository changes;

	private static Instant at(String iso) {
		return Instant.parse(iso);
	}

	@Test
	void findsItemById() {
		Item saved = items.save(item("2025타경20", "1").usageType("아파트")
				.location(new Location("서울 강남구", "서울특별시", "강남구", null, null, null, null, "1.5", "2.5", "L1"))
				.photoInfo(new PhotoInfo(PhotoStatus.COLLECTED, 3, T0)).build());

		Item found = items.findById(saved.getId()).orElseThrow();

		assertThat(found.getCaseNo()).isEqualTo("2025타경20");
		assertThat(found.getLocation().sigungu()).isEqualTo("강남구");
		assertThat(found.getLocation().coordinateX()).isEqualTo("1.5");
		assertThat(found.getPhotoInfo().photoStatus()).isEqualTo(PhotoStatus.COLLECTED);
		assertThat(jdbc.queryForObject("SELECT photo_status FROM items WHERE id = ?", String.class, saved.getId()))
				.isEqualTo("collected");
		assertThat(items.findById(saved.getId() + 999)).isEmpty();
	}

	@Test
	void latestAnalysisIsNewestAnalyzedAtThenHighestId() {
		Item item = items.save(item("2025타경21", "1").build());
		Item other = items.save(item("2025타경22", "1").build());
		analyses.save(new Analysis(item, "오래된", "m", "v1", at("2026-09-01T00:00:00.000Z")));
		Analysis tieFirst = analyses.save(new Analysis(item, "동시각-먼저", "m", "v1", at("2026-09-05T00:00:00.000Z")));
		Analysis tieLast = analyses.save(new Analysis(item, "동시각-나중", "m", "v2", at("2026-09-05T00:00:00.000Z")));
		// id가 가장 크지만 시각은 더 오래된 행: 선택되면 안 된다.
		analyses.save(new Analysis(item, "id만 최대", "m", "v1", at("2026-09-02T00:00:00.000Z")));
		analyses.save(new Analysis(other, "다른 물건", "m", "v9", at("2026-12-01T00:00:00.000Z")));

		Analysis latest = analyses.findFirstByItem_IdOrderByAnalyzedAtDescIdDesc(item.getId()).orElseThrow();

		assertThat(tieLast.getId()).isGreaterThan(tieFirst.getId());
		assertThat(latest.getId()).isEqualTo(tieLast.getId());
		assertThat(latest.getBody()).isEqualTo("동시각-나중");
		assertThat(analyses.findFirstByItem_IdOrderByAnalyzedAtDescIdDesc(other.getId() + 999)).isEmpty();
	}

	@Test
	void changesAreOrderedByChangedAtThenIdAscending() {
		Item item = items.save(item("2025타경23", "1").build());
		Item other = items.save(item("2025타경24", "1").build());
		ItemChange c3 = changes.save(new ItemChange(item, "status", "진행", "변경", at("2026-09-03T00:00:00.000Z"), ChangeKind.CHANGE));
		ItemChange base = changes.save(new ItemChange(item, "minBidPrice", null, "100", at("2026-09-01T00:00:00.000Z"), ChangeKind.BASELINE));
		ItemChange tieA = changes.save(new ItemChange(item, "failedBidCount", "0", "1", at("2026-09-02T00:00:00.000Z"), ChangeKind.CHANGE));
		ItemChange tieB = changes.save(new ItemChange(item, "minBidPrice", "100", "80", at("2026-09-02T00:00:00.000Z"), ChangeKind.CHANGE));
		changes.save(new ItemChange(other, "status", null, "진행", at("2026-09-01T00:00:00.000Z"), ChangeKind.BASELINE));

		List<ItemChange> result = changes.findByItem_IdOrderByChangedAtAscIdAsc(item.getId());

		assertThat(result).extracting(ItemChange::getId).containsExactly(base.getId(), tieA.getId(), tieB.getId(), c3.getId());
		assertThat(result.get(0).getKind()).isEqualTo(ChangeKind.BASELINE);
		assertThat(result.get(0).getOldValue()).isNull();
		assertThat(jdbc.queryForObject("SELECT kind FROM item_changes WHERE id = ?", String.class, base.getId()))
				.isEqualTo("baseline");
	}

	@Test
	void usageTypesAreSplitTrimmedDeduplicatedAndSorted() {
		assertThat(items.listUsageTypes()).isEmpty();

		items.save(item("2025타경30", "1").usageType("아파트").build());
		items.save(item("2025타경30", "2").usageType("아파트").build());
		items.save(item("2025타경31", "1").usageType("다세대주택, 아파트 ,").build());
		items.save(item("2025타경32", "1").usageType("").build());
		items.save(item("2025타경33", "1").usageType("  ").build());
		items.save(item("2025타경34", "1").usageType(null).build());
		items.save(item("2025타경35", "1").usageType("토지,대지").build());

		assertThat(items.listUsageTypes()).containsExactly("다세대주택", "대지", "아파트", "토지");
	}

}
