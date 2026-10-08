package com.auctionboss.worker;

import java.time.LocalDateTime;
import java.util.List;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

/**
 * 워커별 보관 상한 정리. 원본의 {@code DELETE ... WHERE id NOT IN (SELECT ... LIMIT @max)}는 MySQL에서 {@code IN} 서브쿼리의
 * {@code LIMIT}(ER 1235)과 삭제 대상 테이블 서브쿼리(ER 1093)로 막히므로 두 문장으로 나눈다.
 *
 * <ol>
 * <li>경계 행: 최신순({@code started_at DESC, id DESC})으로 {@code max}건을 건너뛴 첫 행(지울 가장 최신 행).</li>
 * <li>있으면 그 행 이하(같은 순서 기준)를 범위 삭제한다. {@code (worker, started_at DESC)} 인덱스를 탄다.</li>
 * </ol>
 * 같은 {@code started_at}이면 id가 작은 쪽이 먼저 지워진다(원본과 같다). 호출은 쓰기 트랜잭션 안에서 한다.
 */
@Component
class WorkerRunPruner {

	private record Boundary(LocalDateTime startedAt, long id) {
	}

	private final JdbcTemplate jdbc;

	WorkerRunPruner(JdbcTemplate jdbc) {
		this.jdbc = jdbc;
	}

	/** 지운 행 수를 돌려준다. */
	int prune(String worker, int max) {
		List<Boundary> boundary = jdbc.query("""
				SELECT started_at, id FROM worker_runs WHERE worker = ?
				ORDER BY started_at DESC, id DESC LIMIT 1 OFFSET ?""",
				(rs, n) -> new Boundary(rs.getObject("started_at", LocalDateTime.class), rs.getLong("id")), worker, max);
		if (boundary.isEmpty()) {
			return 0;
		}
		Boundary b = boundary.get(0);
		return jdbc.update("""
				DELETE FROM worker_runs
				WHERE worker = ? AND (started_at < ? OR (started_at = ? AND id <= ?))""", worker, b.startedAt(),
				b.startedAt(), b.id());
	}

}
