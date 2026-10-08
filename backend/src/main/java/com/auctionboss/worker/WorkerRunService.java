package com.auctionboss.worker;

import java.time.Instant;
import java.time.LocalDateTime;
import java.time.ZoneOffset;

import com.auctionboss.common.json.JsNumbers;
import com.auctionboss.common.time.ServerClock;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.util.MultiValueMap;
import tools.jackson.databind.json.JsonMapper;

/** 워커 회차 기록. 쓰기 하나가 트랜잭션 하나다. */
@Service
public class WorkerRunService {

	private static final JsonMapper JSON = JsonMapper.builder().build();

	private final WorkerRunRepository runs;

	private final WorkerRunQueryRepository queries;

	private final WorkerRunPruner pruner;

	private final WorkerSettings settings;

	private final ServerClock clock;

	private final JdbcTemplate jdbc;

	WorkerRunService(WorkerRunRepository runs, WorkerRunQueryRepository queries, WorkerRunPruner pruner,
			WorkerSettings settings, ServerClock clock, JdbcTemplate jdbc) {
		this.runs = runs;
		this.queries = queries;
		this.pruner = pruner;
		this.settings = settings;
		this.clock = clock;
		this.jdbc = jdbc;
	}

	/** 진행 중 회차를 만들고, 그 워커의 보관 상한을 넘는 오래된 회차를 지운다. */
	@Transactional
	public StartedRun start(String worker) {
		Instant now = clock.now();
		WorkerRun run = runs.saveAndFlush(new WorkerRun(worker, now, null, RunOutcome.RUNNING, null, null, null, null, now));
		pruner.prune(worker, settings.maxRunsPerWorker());
		return new StartedRun(run.getId());
	}

	/** 회차를 종료로 갱신한다. 영향 0행이면 404다. */
	@Transactional
	public WorkerRunResponse finish(String rawId, WorkerRunBodies.FinishRequest req) {
		Instant now = clock.now();
		double asNumber = Double.parseDouble(rawId);
		String label = JsNumbers.format(asNumber);
		if (asNumber >= 9.2e18) {
			throw new WorkerRunNotFoundException(label);
		}
		long id = (long) asNumber;
		String detail = req.detail() == null ? null : JSON.writeValueAsString(req.detail());
		int updated = jdbc.update("""
				UPDATE worker_runs
				SET finished_at = ?, outcome = ?, error_kind = ?, error_message = ?, detail = CAST(? AS JSON),
				    items_changed = ?
				WHERE id = ?""", LocalDateTime.ofInstant(now, ZoneOffset.UTC), req.outcome(), req.errorKind(),
				req.errorMessage(), detail, req.itemsChanged(), id);
		if (updated == 0) {
			throw new WorkerRunNotFoundException(label);
		}
		return WorkerRunResponse.of(runs.findById(id).orElseThrow(() -> new WorkerRunNotFoundException(label)));
	}

	@Transactional(readOnly = true)
	public WorkerRunPage list(MultiValueMap<String, String> params) {
		WorkerRunQueryParser.ListQuery q = WorkerRunQueryParser.parseList(params);
		return queries.list(q.worker(), q.outcome(), q.page());
	}

	@Transactional(readOnly = true)
	public RunsSummary summary(MultiValueMap<String, String> params) {
		WorkerRunQueryParser.SummaryQuery q = WorkerRunQueryParser.parseSummary(params);
		return queries.summarize(q.worker(), q.since());
	}

}
