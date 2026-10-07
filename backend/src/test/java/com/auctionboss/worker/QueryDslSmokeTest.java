package com.auctionboss.worker;

import static org.assertj.core.api.Assertions.assertThat;

import java.time.Instant;

import com.auctionboss.support.AbstractMySqlTest;
import com.querydsl.jpa.impl.JPAQueryFactory;
import jakarta.persistence.EntityManager;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.transaction.annotation.Transactional;

/** QueryDSL 포크(7.0) + Hibernate 호환 확인: Q클래스로 insert 후 조회한다. */
@Transactional
class QueryDslSmokeTest extends AbstractMySqlTest {

	@Autowired
	EntityManager em;

	@Autowired
	JPAQueryFactory queryFactory;

	@Test
	void insertAndQueryWithGeneratedQClass() {
		Instant t = Instant.parse("2026-01-02T03:04:05.678Z");
		em.persist(new CollectorState("last_run", "v1", t));
		em.persist(new CollectorState("other", "v2", Instant.parse("2026-01-03T00:00:00Z")));
		em.flush();
		em.clear();

		QCollectorState s = QCollectorState.collectorState;
		CollectorState found = queryFactory.selectFrom(s).where(s.key.eq("last_run")).fetchOne();

		assertThat(found).isNotNull();
		assertThat(found.getValue()).isEqualTo("v1");
		assertThat(found.getUpdatedAt()).isEqualTo(t);
		assertThat(queryFactory.select(s.count()).from(s).fetchOne()).isEqualTo(2L);
		assertThat(queryFactory.selectFrom(s).orderBy(s.key.asc()).fetch())
				.extracting(CollectorState::getKey).containsExactly("last_run", "other");
	}

}
