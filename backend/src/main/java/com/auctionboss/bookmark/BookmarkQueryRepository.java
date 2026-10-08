package com.auctionboss.bookmark;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;

import com.auctionboss.common.query.PageParams;
import com.auctionboss.history.ChangeKind;
import com.auctionboss.history.QItemChange;
import com.auctionboss.item.Item;
import com.auctionboss.item.QItem;
import com.auctionboss.item.search.ItemPage;
import com.auctionboss.item.dto.ItemResponse;
import com.auctionboss.item.search.ItemSearchRepository;
import com.querydsl.core.Tuple;
import com.querydsl.core.types.Predicate;
import com.querydsl.core.types.dsl.DateTimeExpression;
import com.querydsl.core.types.dsl.Expressions;
import com.querydsl.jpa.JPAExpressions;
import com.querydsl.jpa.impl.JPAQueryFactory;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.annotation.Transactional;

/**
 * 관심 목록과 피드 조회(QueryDSL). 모두 행 수와 무관하게 문장 수가 고정이다.
 *
 * <ul>
 * <li>관심 목록: 건수 1 + 목록 1(bookmarks와 items를 조인하고 목록 행 식 {@code lastChangedAt}을 스칼라 서브쿼리로 읽는다).
 * 원본의 물건별 조회(N+1)는 따라 하지 않는다.</li>
 * <li>피드: 건수 1 + 목록 1 + 미확인 개수 1.</li>
 * </ul>
 */
@Repository
@Transactional(readOnly = true)
class BookmarkQueryRepository {

	private final JPAQueryFactory queryFactory;

	BookmarkQueryRepository(JPAQueryFactory queryFactory) {
		this.queryFactory = queryFactory;
	}

	ItemPage listBookmarkedItems(PageParams.Page page) {
		QBookmark b = QBookmark.bookmark;
		QItem i = QItem.item;
		Long total = queryFactory.select(b.count()).from(b).fetchOne();
		long totalCount = total == null ? 0L : total;
		long offset = page.offset();
		if (offset > Integer.MAX_VALUE) {
			return new ItemPage(List.of(), totalCount, page.page(), page.pageSize());
		}
		List<Tuple> rows = queryFactory.select(i, ItemSearchRepository.lastChangedAt(i)).from(b).join(i)
				.on(i.id.eq(b.itemId)).orderBy(b.createdAt.desc(), b.itemId.desc()).offset(offset)
				.limit(page.pageSize()).fetch();
		List<ItemResponse> items = new ArrayList<>(rows.size());
		for (Tuple row : rows) {
			// 담긴 물건의 목록이므로 bookmarked는 항상 true다.
			items.add(ItemResponse.of(row.get(0, Item.class), row.get(1, Instant.class), true));
		}
		return new ItemPage(items, totalCount, page.page(), page.pageSize());
	}

	FeedResponse listFeed(PageParams.Page page, boolean sinceBookmarkedAt) {
		QItemChange c = QItemChange.itemChange;
		QBookmark b = QBookmark.bookmark;
		QItem i = QItem.item;
		List<Predicate> where = new ArrayList<>();
		// kind='change'가 핵심이다: 기준점(baseline)은 피드가 아니다.
		where.add(c.kind.eq(ChangeKind.CHANGE));
		if (sinceBookmarkedAt) {
			where.add(c.changedAt.gt(b.createdAt));
		}
		Predicate[] conditions = where.toArray(new Predicate[0]);

		Long total = queryFactory.select(c.count()).from(c).join(b).on(b.itemId.eq(c.item.id)).where(conditions)
				.fetchOne();
		long totalCount = total == null ? 0L : total;
		long offset = page.offset();
		List<FeedEntryResponse> entries = new ArrayList<>();
		if (offset <= Integer.MAX_VALUE) {
			List<Tuple> rows = queryFactory
					.select(c.id, c.item.id, i.location.address, c.field, c.oldValue, c.newValue, c.changedAt,
							b.createdAt)
					.from(c).join(b).on(b.itemId.eq(c.item.id)).join(i).on(i.id.eq(c.item.id)).where(conditions)
					.orderBy(c.changedAt.desc(), c.id.desc()).offset(offset).limit(page.pageSize()).fetch();
			for (Tuple row : rows) {
				entries.add(new FeedEntryResponse(row.get(0, Long.class), row.get(1, Long.class),
						row.get(2, String.class), row.get(3, String.class), row.get(4, String.class),
						row.get(5, String.class), row.get(6, Instant.class), row.get(7, Instant.class)));
			}
		}
		return new FeedResponse(entries, totalCount, page.page(), page.pageSize(), unreadCount());
	}

	/**
	 * 미확인 개수: 마지막 확인 시각보다 뒤에 기록된 피드 변경 수. 확인 시각은 스칼라 서브쿼리로 넣어 한 문장이다. 행이 없거나
	 * 값이 NULL이면(한 번도 확인하지 않음) 전체가 미확인이다.
	 */
	long unreadCount() {
		QItemChange c = QItemChange.itemChange;
		QBookmark b = QBookmark.bookmark;
		QFeedRead f = QFeedRead.feedRead;
		DateTimeExpression<Instant> lastRead = Expressions
				.asDateTime(JPAExpressions.select(f.lastReadAt).from(f).where(f.id.eq(FeedRead.SINGLE_ROW_ID)));
		Long count = queryFactory.select(c.count()).from(c).join(b).on(b.itemId.eq(c.item.id))
				.where(c.kind.eq(ChangeKind.CHANGE), lastRead.isNull().or(c.changedAt.gt(lastRead))).fetchOne();
		return count == null ? 0L : count;
	}

}
