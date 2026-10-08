package com.auctionboss.worker;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;

import com.auctionboss.common.query.PageParams;
import com.querydsl.core.Tuple;
import com.querydsl.core.types.Predicate;
import com.querydsl.core.types.dsl.Expressions;
import com.querydsl.jpa.impl.JPAQueryFactory;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.annotation.Transactional;

/** 회차 목록(건수 1 + 목록 1)과 집계(1문장, {@code GROUP BY outcome}) 조회. */
@Repository
@Transactional(readOnly = true)
class WorkerRunQueryRepository {

	private final JPAQueryFactory queryFactory;

	WorkerRunQueryRepository(JPAQueryFactory queryFactory) {
		this.queryFactory = queryFactory;
	}

	WorkerRunPage list(String worker, RunOutcome outcome, PageParams.Page page) {
		QWorkerRun r = QWorkerRun.workerRun;
		List<Predicate> where = new ArrayList<>();
		if (worker != null) {
			where.add(r.worker.eq(worker));
		}
		if (outcome != null) {
			where.add(r.outcome.eq(outcome));
		}
		Predicate[] conditions = where.toArray(new Predicate[0]);

		Long total = queryFactory.select(r.count()).from(r).where(conditions).fetchOne();
		long totalCount = total == null ? 0L : total;
		long offset = page.offset();
		// 오프셋이 int 범위를 넘으면 JPA가 표현하지 못한다. 그만큼 뒤 페이지는 어차피 비어 있다.
		if (offset > Integer.MAX_VALUE) {
			return new WorkerRunPage(List.of(), totalCount, page.page(), page.pageSize());
		}
		List<WorkerRun> rows = queryFactory.selectFrom(r).where(conditions)
				.orderBy(r.startedAt.desc(), r.id.desc()).offset(offset).limit(page.pageSize()).fetch();
		return new WorkerRunPage(rows.stream().map(WorkerRunResponse::of).toList(), totalCount, page.page(),
				page.pageSize());
	}

	RunsSummary summarize(String worker, Instant since) {
		QWorkerRun r = QWorkerRun.workerRun;
		List<Predicate> where = new ArrayList<>();
		if (worker != null) {
			where.add(r.worker.eq(worker));
		}
		if (since != null) {
			where.add(r.startedAt.goe(since));
		}
		List<Tuple> rows = queryFactory.select(r.outcome, r.count(), Expressions.numberTemplate(Long.class, "sum({0})", r.itemsChanged)).from(r)
				.where(where.toArray(new Predicate[0])).groupBy(r.outcome).fetch();

		long success = 0, failed = 0, blocked = 0, skipped = 0, running = 0, changed = 0;
		for (Tuple row : rows) {
			RunOutcome outcome = row.get(0, RunOutcome.class);
			long count = row.get(1, Long.class);
			Number sum = row.get(2, Number.class);
			changed += sum == null ? 0 : sum.longValue();
			switch (outcome) {
				case SUCCESS -> success = count;
				case FAILED -> failed = count;
				case BLOCKED -> blocked = count;
				case SKIPPED -> skipped = count;
				case RUNNING -> running = count;
			}
		}
		long completed = success + failed + blocked;
		long total = completed + skipped + running;
		Double rate = completed > 0 ? (double) success / completed : null;
		return new RunsSummary(total, success, failed, blocked, skipped, running, rate, changed);
	}

}
