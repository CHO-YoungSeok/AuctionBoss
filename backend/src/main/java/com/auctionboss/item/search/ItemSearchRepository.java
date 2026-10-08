package com.auctionboss.item.search;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.List;

import com.auctionboss.analysis.AnalysisSettings;
import com.auctionboss.analysis.QAnalysis;
import com.auctionboss.bookmark.QBookmark;
import com.auctionboss.history.ChangeKind;
import com.auctionboss.history.QItemChange;
import com.auctionboss.item.QItem;
import com.auctionboss.item.dto.ItemResponse;
import com.auctionboss.photo.PhotoStatus;
import com.querydsl.core.Tuple;
import com.querydsl.core.types.Expression;
import com.querydsl.core.types.Order;
import com.querydsl.core.types.OrderSpecifier;
import com.querydsl.core.types.Predicate;
import com.querydsl.core.types.dsl.BooleanExpression;
import com.querydsl.core.types.dsl.CaseBuilder;
import com.querydsl.core.types.dsl.Expressions;
import com.querydsl.core.types.dsl.NumberTemplate;
import com.querydsl.core.types.dsl.StringExpression;
import com.querydsl.jpa.JPAExpressions;
import com.querydsl.jpa.JPQLSubQuery;
import com.querydsl.jpa.impl.JPAQuery;
import com.querydsl.jpa.impl.JPAQueryFactory;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.annotation.Transactional;

/**
 * 물건 목록 검색(QueryDSL). 원본 {@code repository.ts}의 {@code listItems}/{@code buildFilter}와 같은 의미다.
 *
 * <ul>
 * <li>목록 행의 {@code lastChangedAt}, {@code bookmarked}는 스칼라 서브쿼리로 같은 SELECT에서 가져온다(N+1 없음).
 * 목록 1회 = SELECT 1개(행) + COUNT 1개.</li>
 * <li>NULL은 방향과 무관하게 항상 뒤, 보조 정렬은 {@code id ASC}.</li>
 * <li>비율 정렬은 {@code cast(... as double)}로 실수 나눗셈을 강제한다(MySQL 정수 나눗셈은 소수 4자리 DECIMAL이다).</li>
 * <li>"최신 분석"({@code analyzed_at DESC, id DESC}의 첫 행)은 LIMIT 없이 MAX 서브쿼리로 고른다.</li>
 * </ul>
 */
@Repository
@Transactional(readOnly = true)
public class ItemSearchRepository {

	/** 지난 기일 제외의 "오늘"은 UTC가 아니라 한국 시간 기준이다(원본 todayInSeoul). */
	private static final ZoneId SEOUL = ZoneId.of("Asia/Seoul");

	private static final char LIKE_ESCAPE = '\\';

	private final JPAQueryFactory queryFactory;

	private final Clock clock;

	private final AnalysisSettings analysisSettings;

	public ItemSearchRepository(JPAQueryFactory queryFactory, Clock clock, AnalysisSettings analysisSettings) {
		this.queryFactory = queryFactory;
		this.clock = clock;
		this.analysisSettings = analysisSettings;
	}

	public ItemPage search(ItemSearchCondition c) {
		Instant now = clock.instant();
		QItem item = QItem.item;
		Predicate[] where = filters(c, item, now).toArray(new Predicate[0]);

		Long total = queryFactory.select(item.count()).from(item).where(where).fetchOne();
		long totalCount = total == null ? 0L : total;

		long offset = (c.page() - 1) * c.pageSize();
		// 오프셋이 int 범위를 넘으면 JPA가 표현하지 못한다. 그만큼 뒤 페이지는 어차피 비어 있다.
		if (offset > Integer.MAX_VALUE) {
			return new ItemPage(List.of(), totalCount, c.page(), c.pageSize());
		}

		JPAQuery<Tuple> query = queryFactory.select(item, lastChangedAt(item), bookmarkedFlag(item)).from(item)
				.where(where);
		if (c.needsAnalysis()) {
			// 재분석 후보는 가장 오래 전에 분석된 것 우선(호출자의 sort는 무시한다, 원본 NEEDS_ANALYSIS_ORDER).
			query.orderBy(new OrderSpecifier<>(Order.ASC, latestAnalyzedAt(item)), item.id.asc());
		}
		else {
			query.orderBy(orderBy(c, item));
		}
		List<Tuple> rows = query.offset(offset).limit(c.pageSize()).fetch();

		List<ItemResponse> items = new ArrayList<>(rows.size());
		for (Tuple row : rows) {
			items.add(ItemResponse.of(row.get(0, com.auctionboss.item.Item.class), row.get(1, Instant.class),
					Boolean.TRUE.equals(row.get(2, Boolean.class))));
		}
		return new ItemPage(items, totalCount, c.page(), c.pageSize());
	}

	/** 상세용 단건 조회: 목록과 같은 서브쿼리 컬럼(lastChangedAt, bookmarked)을 한 SELECT로 가져온다. */
	public java.util.Optional<ItemResponse> findDetail(long id) {
		QItem item = QItem.item;
		Tuple row = queryFactory.select(item, lastChangedAt(item), bookmarkedFlag(item)).from(item)
				.where(item.id.eq(id)).fetchOne();
		if (row == null) {
			return java.util.Optional.empty();
		}
		return java.util.Optional.of(ItemResponse.of(row.get(0, com.auctionboss.item.Item.class),
				row.get(1, Instant.class), Boolean.TRUE.equals(row.get(2, Boolean.class))));
	}

	// ---- 필터 ----

	private List<Predicate> filters(ItemSearchCondition c, QItem item, Instant now) {
		List<Predicate> p = new ArrayList<>();

		if (c.analyzed() != null) {
			BooleanExpression analyzed = hasAnalysis(item);
			p.add(c.analyzed() ? analyzed : analyzed.not());
		}
		if (c.needsAnalysis()) {
			p.add(needsAnalysis(item, c.promptVersion(), now));
		}
		if (c.usageTypes() != null && !c.usageTypes().isEmpty()) {
			// 토큰 단위 매칭: ',' || usage_type || ',' LIKE '%,<토큰>,%'. usage_type이 NULL이면 거짓이다.
			StringExpression padded = Expressions.asString(",").concat(item.usageType).concat(",");
			BooleanExpression any = null;
			for (String usage : c.usageTypes()) {
				BooleanExpression one = padded.like("%," + escapeLike(usage) + ",%", LIKE_ESCAPE);
				any = any == null ? one : any.or(one);
			}
			p.add(any);
		}
		if (c.minPrice() != null) {
			p.add(item.minBidPrice.goe(c.minPrice()));
		}
		if (c.maxPrice() != null) {
			p.add(item.minBidPrice.loe(c.maxPrice()));
		}
		if (c.minFailedBidCount() != null) {
			p.add(item.failedBidCount.goe(c.minFailedBidCount()));
		}
		if (c.keyword() != null && !c.keyword().isBlank()) {
			String pattern = "%" + escapeLike(c.keyword().trim()) + "%";
			p.add(item.location.address.like(pattern, LIKE_ESCAPE).or(item.caseNo.like(pattern, LIKE_ESCAPE))
					.or(item.location.buildingName.like(pattern, LIKE_ESCAPE)));
		}
		if (c.court() != null) {
			p.add(item.court.eq(c.court()));
		}
		if (c.minDiscountRate() != null) {
			// 감정가가 0 이하이거나 최저가가 NULL이면 제외. 비율은 실수로 계산한다.
			NumberTemplate<Double> rate = Expressions.numberTemplate(Double.class,
					"cast({0} - {1} as double) / {0} * 100", item.appraisalPrice, item.minBidPrice);
			p.add(item.appraisalPrice.gt(0L).and(rate.goe(c.minDiscountRate().doubleValue())));
		}
		if (c.hasPhotos() != null) {
			BooleanExpression collected = item.photoInfo.photoStatus.eq(PhotoStatus.COLLECTED);
			p.add(c.hasPhotos() ? collected : item.photoInfo.photoStatus.isNull().or(collected.not()));
		}
		if (c.sidoValues() != null && !c.sidoValues().isEmpty()) {
			p.add(item.location.sido.in(c.sidoValues()));
		}
		if (c.sigunguValues() != null && !c.sigunguValues().isEmpty()) {
			p.add(item.location.sigungu.in(c.sigunguValues()));
		}
		if (c.auctionDateFrom() != null) {
			p.add(item.schedule.auctionDate.goe(c.auctionDateFrom()));
		}
		if (c.auctionDateTo() != null) {
			p.add(item.schedule.auctionDate.loe(c.auctionDateTo()));
		}
		if (c.excludePast()) {
			p.add(item.schedule.auctionDate.goe(LocalDate.ofInstant(now, SEOUL)));
		}
		if (c.bookmarked() != null) {
			BooleanExpression exists = bookmarkExists(item);
			p.add(c.bookmarked() ? exists : exists.not());
		}
		return p;
	}

	/** LIKE 패턴 안의 {@code \}, {@code %}, {@code _}를 글자 그대로 검색하도록 이스케이프한다(원본 escapeLikePattern). */
	static String escapeLike(String value) {
		StringBuilder sb = new StringBuilder(value.length() + 4);
		for (int i = 0; i < value.length(); i++) {
			char ch = value.charAt(i);
			if (ch == '\\' || ch == '%' || ch == '_') {
				sb.append(LIKE_ESCAPE);
			}
			sb.append(ch);
		}
		return sb.toString();
	}

	// ---- 정렬 ----

	private OrderSpecifier<?>[] orderBy(ItemSearchCondition c, QItem item) {
		boolean desc = c.direction() == SortDirection.DESC;
		com.querydsl.core.types.dsl.ComparableExpressionBase<?> expr = switch (c.sort()) {
			case AUCTION_DATE -> item.schedule.auctionDate;
			case MIN_BID_PRICE -> item.minBidPrice;
			case FAILED_BID_COUNT -> item.failedBidCount;
			// 감정가 대비 최저가 비율. 감정가 0은 NULLIF로 NULL이 되어 NULL 규칙(뒤)에 맡긴다.
			case BID_RATIO -> Expressions.numberTemplate(Double.class,
					"cast({0} as double) / nullif({1}, 0L)", item.minBidPrice, item.appraisalPrice);
			// 면적당 가격: minArea 우선, 없거나 0이면 maxArea, 둘 다 없으면 NULL.
			case PRICE_PER_AREA -> Expressions.numberTemplate(Double.class,
					"cast({0} as double) / nullif(coalesce(nullif({1}, 0), nullif({2}, 0)), 0)", item.minBidPrice,
					item.minArea, item.maxArea);
		};
		// MySQL의 기본 NULL 순서(ASC에서 NULL 먼저, DESC에서 NULL 나중)에 기대지 않고
		// "NULL이면 1" 키를 앞세워 방향과 무관하게 NULL을 뒤로 보낸다(원본 `(expr) IS NULL, expr`).
		OrderSpecifier<Integer> nullsLast = new CaseBuilder().when(expr.isNull()).then(1).otherwise(0).asc();
		@SuppressWarnings({ "unchecked", "rawtypes" })
		OrderSpecifier<?> value = new OrderSpecifier(desc ? Order.DESC
				: Order.ASC, expr);
		return new OrderSpecifier<?>[] { nullsLast, value, item.id.asc() };
	}

	// ---- 서브쿼리 ----

	private static BooleanExpression hasAnalysis(QItem item) {
		QAnalysis a = new QAnalysis("an_exists");
		return JPAExpressions.selectOne().from(a).where(a.item.id.eq(item.id)).exists();
	}

	private static BooleanExpression bookmarkExists(QItem item) {
		QBookmark b = new QBookmark("bm_exists");
		return JPAExpressions.selectOne().from(b).where(b.itemId.eq(item.id)).exists();
	}

	/** 목록 행의 "가장 최근 실제 변경 시각": kind='change'인 이력의 MAX(changed_at). 기준점(baseline)은 제외한다. */
	private static JPQLSubQuery<Instant> lastChangedAt(QItem item) {
		QItemChange ch = new QItemChange("ch_last");
		return JPAExpressions.select(ch.changedAt.max()).from(ch)
				.where(ch.item.id.eq(item.id), ch.kind.eq(ChangeKind.CHANGE));
	}

	/** 목록 행의 관심 여부. 필터와는 별개의 SELECT 컬럼이다. */
	private static Expression<Boolean> bookmarkedFlag(QItem item) {
		return new CaseBuilder().when(bookmarkExists(item)).then(true).otherwise(false);
	}

	/** 물건의 최신 분석 시각. 최신 행의 analyzed_at은 곧 MAX(analyzed_at)이다. 분석이 없으면 NULL. */
	private static JPQLSubQuery<Instant> latestAnalyzedAt(QItem item) {
		QAnalysis a = new QAnalysis("an_latest_at");
		return JPAExpressions.select(a.analyzedAt.max()).from(a).where(a.item.id.eq(item.id));
	}

	/**
	 * 최신 분석 행의 프롬프트 버전이 요청과 다른가. 원본은 {@code ORDER BY analyzed_at DESC, id DESC LIMIT 1}인데
	 * JPQL 서브쿼리는 LIMIT을 쓸 수 없어, "최신 시각 -> 그 시각의 MAX(id)" 두 단계로 같은 행을 고른다.
	 */
	private static BooleanExpression latestPromptVersionDiffers(QItem item, String promptVersion) {
		QAnalysis a = new QAnalysis("an_latest_row");
		QAnalysis sameTime = new QAnalysis("an_latest_id");
		QAnalysis newest = new QAnalysis("an_latest_ts");
		JPQLSubQuery<Long> latestIdAtNewest = JPAExpressions.select(sameTime.id.max()).from(sameTime)
				.where(sameTime.item.id.eq(item.id), sameTime.analyzedAt.eq(
						JPAExpressions.select(newest.analyzedAt.max()).from(newest).where(newest.item.id.eq(item.id))));
		return JPAExpressions.selectOne().from(a)
				.where(a.item.id.eq(item.id), a.id.eq(latestIdAtNewest), a.promptVersion.ne(promptVersion)).exists();
	}

	/**
	 * 재분석 대상 판정(원본 NEEDS_ANALYSIS_PREDICATE). 분석이 있는 물건 중
	 * (1) 최신 분석 이후 실제 변경(kind='change', 기준점 제외)이 있거나 (2) 최신 분석의 프롬프트 버전이 다르고,
	 * (3) 최신 분석이 재분석 최소 간격보다 오래된 것. 변경 비교는 초과({@code >})다.
	 */
	private BooleanExpression needsAnalysis(QItem item, String promptVersion, Instant now) {
		QItemChange nc = new QItemChange("ch_needs");
		BooleanExpression changedSinceAnalysis = JPAExpressions.selectOne().from(nc)
				.where(nc.item.id.eq(item.id), nc.kind.eq(ChangeKind.CHANGE), nc.changedAt.gt(latestAnalyzedAt(item)))
				.exists();
		long cooldownMillis = (long) (analysisSettings.reanalysisCooldownHours() * 60.0 * 60.0 * 1000.0);
		Instant cooldownBefore = now.minus(Duration.ofMillis(cooldownMillis));
		return hasAnalysis(item)
				.and(changedSinceAnalysis.or(latestPromptVersionDiffers(item, promptVersion)))
				.and(Expressions.asDateTime(latestAnalyzedAt(item)).loe(cooldownBefore));
	}

}
