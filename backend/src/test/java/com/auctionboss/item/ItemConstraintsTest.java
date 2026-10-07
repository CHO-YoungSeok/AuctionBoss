package com.auctionboss.item;

import static com.auctionboss.support.TestData.T0;
import static com.auctionboss.support.TestData.item;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.auctionboss.analysis.Analysis;
import com.auctionboss.analysis.AnalysisRepository;
import com.auctionboss.history.ChangeKind;
import com.auctionboss.history.ItemChange;
import com.auctionboss.history.ItemChangeRepository;
import com.auctionboss.photo.ItemPhoto;
import com.auctionboss.bookmark.Bookmark;
import com.auctionboss.support.AbstractMySqlTest;
import jakarta.persistence.EntityManager;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.transaction.support.TransactionTemplate;

/** 스펙 "고유 제약 유지"와 외래 키 CASCADE. */
class ItemConstraintsTest extends AbstractMySqlTest {

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

	@Test
	void duplicateNaturalKeyIsRejected() {
		items.saveAndFlush(item("2025타경1", "1").build());

		assertThatThrownBy(() -> items.saveAndFlush(item("2025타경1", "1").build()))
				.isInstanceOf(DataIntegrityViolationException.class);

		// 같은 사건이라도 물건번호가 다르면 허용
		items.saveAndFlush(item("2025타경1", "2").build());
		assertThat(items.count()).isEqualTo(2);
	}

	@Test
	void deletingItemCascadesToChildRows() {
		Item keep = items.saveAndFlush(item("2025타경2", "1").build());
		Item victim = items.saveAndFlush(item("2025타경3", "1").build());
		for (Item i : new Item[] { keep, victim }) {
			analyses.save(new Analysis(i, "본문", "m", "v1", T0));
			changes.save(new ItemChange(i, "minBidPrice", null, "100", T0, ChangeKind.BASELINE));
			tx.executeWithoutResult(s -> {
				em.persist(new ItemPhoto(i, 1, "/p/1.jpg", 10L, "image/jpeg", T0));
				em.persist(new Bookmark(i.getId(), T0));
			});
		}

		jdbc.update("DELETE FROM items WHERE id = ?", victim.getId());

		for (String table : new String[] { "analyses", "item_changes", "item_photos" }) {
			assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM " + table + " WHERE item_id = ?", Integer.class,
					victim.getId())).as(table).isZero();
			assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM " + table + " WHERE item_id = ?", Integer.class,
					keep.getId())).as(table + " (유지 대상)").isEqualTo(1);
		}
		assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM bookmarks WHERE item_id = ?", Integer.class,
				victim.getId())).isZero();
		assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM bookmarks WHERE item_id = ?", Integer.class,
				keep.getId())).isEqualTo(1);
	}

}
