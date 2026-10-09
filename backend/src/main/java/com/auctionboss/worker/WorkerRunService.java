package com.auctionboss.worker;

import java.time.Instant;
import java.time.LocalDateTime;
import java.time.ZoneOffset;
import java.util.Map;

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
		double asNumber = Double.parseDouble(rawId);
		String label = JsNumbers.format(asNumber);
		if (asNumber >= 9.2e18) {
			throw new WorkerRunNotFoundException(label);
		}
		long id = (long) asNumber;
		updateFinished(id, label, req.outcome(), req.errorKind(), req.errorMessage(), req.detail());
		return WorkerRunResponse.of(runs.findById(id).orElseThrow(() -> new WorkerRunNotFoundException(label)));
	}

	/**
	 * 워커가 자기 회차를 종료로 갱신한다(API {@link #finish}와 같은 갱신 문장). 집계용 {@code items_changed}는 {@code detail}의
	 * {@code changed}에서만 정해진다. 행이 없으면 {@link WorkerRunNotFoundException}이다.
	 */
	@Transactional
	public void finishRun(long id, String outcome, String errorKind, String errorMessage, Map<String, Object> detail) {
		updateFinished(id, Long.toString(id), outcome, errorKind, errorMessage, detail);
	}

	/**
	 * 건너뛴 회차를 한 번에 기록한다: 시작과 종료가 지금이고 {@code error_kind}가 사유({@code overlap}·{@code backoff})다. 시작 기록과
	 * 같이 그 워커의 보관 상한을 넘는 오래된 회차를 지운다.
	 */
	@Transactional
	public void recordSkipped(String worker, String reason) {
		Instant now = clock.now();
		runs.saveAndFlush(new WorkerRun(worker, now, now, RunOutcome.SKIPPED, reason, null, null, null, now));
		pruner.prune(worker, settings.maxRunsPerWorker());
	}

	private void updateFinished(long id, String label, String outcome, String errorKind, String errorMessage,
			Map<String, Object> detail) {
		Instant now = clock.now();
		String json = detail == null ? null : JSON.writeValueAsString(detail);
		Number itemsChanged = detail != null && detail.get("changed") instanceof Number n ? n : null;
		int updated = jdbc.update("""
				UPDATE worker_runs
				SET finished_at = ?, outcome = ?, error_kind = ?, error_message = ?, detail = CAST(? AS JSON),
				    items_changed = ?
				WHERE id = ?""", LocalDateTime.ofInstant(now, ZoneOffset.UTC), outcome, errorKind, errorMessage, json,
				itemsChanged, id);
		if (updated == 0) {
			throw new WorkerRunNotFoundException(label);
		}
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
