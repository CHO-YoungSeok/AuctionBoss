package com.auctionboss.worker;

import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Optional;

import com.auctionboss.common.query.PageParams;
import com.auctionboss.common.time.ServerClock;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * 워커 상태 판정. 원본 {@code getWorkerStatus}(worker-runs.ts)와 같은 규칙이다. 상태를 저장하지 않고 호출마다 기록에서 도출한다.
 *
 * <ol>
 * <li>기록이 없으면 stale.</li>
 * <li>기준 시각(마지막 성공의 종료 시각, 성공이 없으면 마지막 회차의 시작 시각)이 기대 주기 × 배수보다 오래됐으면 stale.</li>
 * <li>마지막 완료 회차(성공·실패·차단)가 blocked면 blocked, failed면 failed, 아니면 ok.</li>
 * </ol>
 *
 * "지금"은 주입된 {@link ServerClock}이다. 기대 주기와 배수는 {@link WorkerSettings}가 호출마다 읽는다.
 */
@Service
@Transactional(readOnly = true)
public class WorkerStatusService {

	private static final List<RunOutcome> COMPLETED = List.of(RunOutcome.SUCCESS, RunOutcome.FAILED,
			RunOutcome.BLOCKED);

	private final WorkerRunRepository runs;

	private final WorkerSettings settings;

	private final ServerClock clock;

	WorkerStatusService(WorkerRunRepository runs, WorkerSettings settings, ServerClock clock) {
		this.runs = runs;
		this.settings = settings;
		this.clock = clock;
	}

	/** {@code worker}는 필수다. 없거나 알 수 없는 값이면 400(field=worker). 쿼리는 최대 3개다. */
	public WorkerStatusResponse status(Map<String, List<String>> params) {
		String worker = parseWorker(params);
		Instant now = clock.now();
		long thresholdMs = settings.intervalMs(worker) * settings.staleAfterIntervals();

		Optional<WorkerRun> last = runs.findFirstByWorkerOrderByStartedAtDescIdDesc(worker);
		if (last.isEmpty()) {
			return new WorkerStatusResponse("stale", null, null);
		}
		WorkerRunResponse lastRun = WorkerRunResponse.of(last.get());
		Optional<WorkerRun> lastSuccess = runs.findFirstByWorkerAndOutcomeOrderByStartedAtDescIdDesc(worker,
				RunOutcome.SUCCESS);
		Instant lastSuccessAt = lastSuccess.map(WorkerRun::getFinishedAt).orElse(null);

		// 성공이 있으면 그 시각만 본다(그 뒤 실패·건너뜀이 더 최근이어도 무관). 없으면 마지막 기록의 시작 시각.
		Instant reference = lastSuccessAt != null ? lastSuccessAt : last.get().getStartedAt();
		long ageMs = Duration.between(reference, now).toMillis();
		if (ageMs > thresholdMs) {
			return new WorkerStatusResponse("stale", lastSuccessAt, lastRun);
		}

		String state = "ok";
		Optional<WorkerRun> lastCompleted = runs.findFirstByWorkerAndOutcomeInOrderByStartedAtDescIdDesc(worker,
				COMPLETED);
		if (lastCompleted.isPresent()) {
			RunOutcome outcome = lastCompleted.get().getOutcome();
			if (outcome == RunOutcome.BLOCKED) {
				state = "blocked";
			}
			else if (outcome == RunOutcome.FAILED) {
				state = "failed";
			}
		}
		return new WorkerStatusResponse(state, lastSuccessAt, lastRun);
	}

	private static String parseWorker(Map<String, List<String>> params) {
		PageParams p = PageParams.of(params);
		String raw = p.read("worker");
		if (raw == null) {
			p.issue("worker", "worker는 필수입니다");
		}
		else if (!WorkerKind.ALL.contains(raw)) {
			p.issue("worker", "worker는 " + String.join(", ", WorkerKind.ALL) + " 중 하나여야 합니다");
		}
		p.throwIfInvalid();
		return raw;
	}

}
