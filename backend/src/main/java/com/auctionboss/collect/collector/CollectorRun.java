package com.auctionboss.collect.collector;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.function.Supplier;

import com.auctionboss.collect.run.BackoffStore;
import com.auctionboss.collect.run.CollectorSettings;
import com.auctionboss.collect.source.AuctionSource;
import com.auctionboss.collect.source.CollectScope;
import com.auctionboss.collect.source.CourtRef;
import com.auctionboss.collect.source.FetchActiveItemsResult;
import com.auctionboss.collect.source.SourceBlockedException;
import com.auctionboss.collect.source.SourceException;
import com.auctionboss.collect.source.SourceItem;
import com.auctionboss.common.time.ServerClock;
import com.auctionboss.worker.RunOutcome;
import com.auctionboss.worker.WorkerRunService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Service;

/**
 * 수집 회차 본체 (TS {@code workers/collector.ts}의 {@code runOnce}와 틱의 차단 처리). 스케줄링·단일 실행 잠금·"백오프 중이면 건너뜀"은
 * 이 클래스가 아니라 틱(5장)의 몫이다. 이 클래스는 호출되면 회차 하나를 끝까지 한다.
 *
 * <ol>
 * <li>로테이션: 저장된 위치(없거나 목록에 없으면 처음)에서 {@code maxCourtsPerRun}곳을 고른다.</li>
 * <li>회차 시작 기록. 법원마다 {@code fetchActiveItems}를 따로 부른다. 두 번째 법원부터는 누적 요청 수가
 * {@code maxRequestsPerRun} 이상이면 그 법원부터 시작하지 않는다(이미 시작한 법원은 끊지 않는다).</li>
 * <li><b>모든 법원이 끝난 뒤</b> 물건을 한 번에 저장한다(한 트랜잭션).</li>
 * <li>회차 종료 기록, 로테이션 위치 저장. 실패하면 실패한 법원이 다음 시작 위치가 되고, 차단이면 공유 백오프를 {@code now + 길이}로
 * 늘린다.</li>
 * </ol>
 * 회차 기록·로테이션·백오프 기록의 실패는 로그만 남기고 수집을 막지 않는다. 회차에서 나는 어떤 예외도 밖으로 던지지 않고 결과로 돌려준다.
 */
@Service
public class CollectorRun {

	private static final Logger log = LoggerFactory.getLogger(CollectorRun.class);

	/** 회차 결과. {@code outcome}은 success·failed·blocked 중 하나다. */
	public record Result(RunOutcome outcome, String errorKind, String errorMessage, CollectorRunDetail detail) {
	}

	private final ObjectProvider<AuctionSource> sources;

	private final ItemUpsertService upsert;

	private final WorkerRunService runs;

	private final RotationStore rotation;

	private final BackoffStore backoff;

	private final CollectorSettings settings;

	private final ServerClock clock;

	CollectorRun(ObjectProvider<AuctionSource> sources, ItemUpsertService upsert, WorkerRunService runs,
			RotationStore rotation, BackoffStore backoff, CollectorSettings settings, ServerClock clock) {
		this.sources = sources;
		this.upsert = upsert;
		this.runs = runs;
		this.rotation = rotation;
		this.backoff = backoff;
		this.settings = settings;
		this.clock = clock;
	}

	/** 설정 파일의 범위로 회차를 한다. 범위는 회차마다 읽는다. */
	public Result run() {
		return run(settings.scope());
	}

	public Result run(CollectorSettings.Scope scope) {
		String stored = safe("로테이션 위치 조회 실패 - 처음(첫 법원)부터 다시 시작합니다(자가 복구)", rotation::get, null);
		RotationSelector.Selection selection = RotationSelector.select(scope.courts(), stored,
				scope.maxCourtsPerRun());
		String nextStart = selection.nextStartCourtCode();
		log.info("[collector] 수집 시작 - 로테이션 대상: {}", label(selection.selectedCourts()));

		Long runId = safe("회차 시작 기록 실패 - 수집은 계속 진행합니다", () -> runs.start("collector").id(), null);

		List<String> targetCourts = new ArrayList<>();
		int pagesRequested = 0;
		int itemsFetched = 0;
		int inserted = 0;
		int updated = 0;
		int changed = 0;
		List<SourceItem> allItems = new ArrayList<>();
		try {
			AuctionSource source = sources.getObject();
			List<CourtRef> selected = selection.selectedCourts();
			for (int index = 0; index < selected.size(); index++) {
				CourtRef court = selected.get(index);
				// 이미 시작한 법원은 끊지 않는다(index 0은 예산과 무관하게 항상 시도): 중간에 끊으면 그 법원 물건이 "줄었다"로 오해된다.
				if (index > 0 && pagesRequested >= scope.maxRequestsPerRun()) {
					log.warn("[collector] 요청 수 안전장치({}) 도달 - {}부터는 이번 회차에서 시작하지 않습니다(다음 회차에 이어서 시도)",
							scope.maxRequestsPerRun(), court.name());
					nextStart = court.courtCode();
					break;
				}
				try {
					FetchActiveItemsResult result = source.fetchActiveItems(new CollectScope(List.of(court)));
					targetCourts.add(court.name());
					pagesRequested += result.pagesRequested();
					itemsFetched += result.items().size();
					allItems.addAll(result.items());
				}
				catch (RuntimeException e) {
					targetCourts.add(court.name());
					if (e instanceof SourceException se) {
						pagesRequested += se.requestsMade();
					}
					// 이 법원은 끝까지 수집되지 못했다: 다음 회차는 다른 법원으로 건너뛰지 않고 이 법원부터 다시 시도한다(차단 시 위치 유지).
					nextStart = court.courtCode();
					throw e;
				}
			}
			log.info("[collector] 수집된 물건 {}건", allItems.size());

			UpsertResult saved = upsert.upsertItems(allItems, clock.now());
			inserted = saved.inserted();
			updated = saved.updated();
			changed = saved.changed();
			CollectorRunDetail detail = new CollectorRunDetail(targetCourts, pagesRequested, itemsFetched, inserted,
					updated, changed);
			log.info("[collector] 저장 완료 - inserted={}, updated={}, changed={}", inserted, updated, changed);
			finish(runId, RunOutcome.SUCCESS, null, null, detail);
			safeSetRotation(nextStart);
			return new Result(RunOutcome.SUCCESS, null, null, detail);
		}
		catch (RuntimeException e) {
			// 소스 오류 이름을 그대로 error_kind로 쓴다. 차단(WAF·로봇탐지)은 blocked, 그 밖은 failed.
			boolean blocked = e instanceof SourceBlockedException;
			String errorKind = e instanceof SourceException se ? se.kind() : e.getClass().getSimpleName();
			RunOutcome outcome = blocked ? RunOutcome.BLOCKED : RunOutcome.FAILED;
			CollectorRunDetail detail = new CollectorRunDetail(targetCourts, pagesRequested, itemsFetched, inserted,
					updated, changed);
			finish(runId, outcome, errorKind, e.getMessage(), detail);
			safeSetRotation(nextStart);
			if (blocked) {
				Instant until = clock.now().plusMillis(settings.blockBackoffMs());
				safe("백오프 기록 실패 - 다음 회차에 차단이 다시 감지될 수 있습니다", () -> {
					backoff.extend(until);
					return null;
				}, null);
				log.error("[collector] 소스가 접근을 차단했습니다 ({}). {}ms 동안 수집을 멈춥니다.", errorKind, settings.blockBackoffMs(), e);
			}
			else {
				log.error("[collector] 수집 회차가 실패했습니다 (다음 주기에 다시 시도합니다)", e);
			}
			return new Result(outcome, errorKind, e.getMessage(), detail);
		}
	}

	/** {@code runId}가 없으면(시작 기록이 실패했으면) 종료 기록을 시도하지 않는다: 갱신할 행이 없고, 새 행은 시작 시각이 달라진다. */
	private void finish(Long runId, RunOutcome outcome, String errorKind, String errorMessage,
			CollectorRunDetail detail) {
		if (runId == null) {
			return;
		}
		safe("회차 종료 기록 실패 - 수집 결과에는 영향 없음", () -> {
			runs.finishRun(runId, outcome.dbValue(), errorKind, errorMessage, detail.toMap());
			return null;
		}, null);
	}

	private void safeSetRotation(String courtCode) {
		safe("로테이션 위치 저장 실패 - 다음 회차는 이번과 같은 법원부터 다시 시도합니다", () -> {
			rotation.set(courtCode);
			return null;
		}, null);
	}

	private <T> T safe(String failureMessage, Supplier<T> action, T fallback) {
		try {
			return action.get();
		}
		catch (RuntimeException e) {
			log.error("[collector] {}", failureMessage, e);
			return fallback;
		}
	}

	private static String label(List<CourtRef> courts) {
		return String.join(", ", courts.stream()
			.map(c -> c.name() + "(" + (c.courtCode().isEmpty() ? "코드 미지정" : c.courtCode()) + ")")
			.toList());
	}

}
