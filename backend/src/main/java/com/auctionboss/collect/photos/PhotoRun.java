package com.auctionboss.collect.photos;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.function.Supplier;

import com.auctionboss.collect.photos.PhotoSaveService.SavedPhoto;
import com.auctionboss.collect.run.BackoffStore;
import com.auctionboss.collect.run.CollectorSettings;
import com.auctionboss.collect.source.AuctionSource;
import com.auctionboss.collect.source.FetchItemPhotosResult;
import com.auctionboss.collect.source.PhotoLookupRef;
import com.auctionboss.collect.source.SourceBlockedException;
import com.auctionboss.collect.source.SourceException;
import com.auctionboss.collect.source.SourcePhoto;
import com.auctionboss.collect.source.Sleeper;
import com.auctionboss.common.time.ServerClock;
import com.auctionboss.photo.PhotoStatus;
import com.auctionboss.worker.RunOutcome;
import com.auctionboss.worker.WorkerRunService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Service;

/**
 * 사진 회차 본체(TS {@code workers/photos.ts}의 {@code runRound}). 스케줄링·단일 실행 잠금·"백오프 중이면 건너뜀"은 틱의 몫이고, 이
 * 클래스는 호출되면 회차 하나를 끝까지 한다. 회차에서 나는 어떤 예외도 밖으로 던지지 않고 결과로 돌려준다.
 *
 * <ul>
 * <li>대기 물건 선택({@link PendingPhotoQuery}). 없으면 소스를 만들지도 부르지도 않고 성공 0건이다. 소스는 회차마다 새로 받는다(사진
 * 세션 수명이 회차 하나).</li>
 * <li>물건 사이에 {@code requestDelayMs}만큼 기다리고(첫 물건 앞에는 없음), 요청 직전에 공유 백오프를 다시 읽어 다른 워커가 차단을 기록했으면
 * 남은 물건을 요청하지 않고 멈춘다(이 워커의 실패가 아니다). 식별자가 없거나 빈 문자열인 물건은 요청도 실패 기록도 없이 건너뛴다.</li>
 * <li>사진이 있으면 파일을 먼저 쓰고 DB를 갱신한다(수집됨). 없으면 {@code empty}. 소스·파일·DB 오류는 그 물건만 {@code failed}로
 * 기록한다. <b>차단</b>은 물건의 문제가 아니라 IP의 문제라 물건을 실패로 적지 않고 공유 백오프를 {@code now + 길이}로 늘린 뒤 회차를
 * 끝낸다(백오프 뒤 미시도 상태로 다시 시도).</li>
 * <li>결과 규칙: 차단 &gt; 시도한 물건이 전부 실패 &gt; 성공(일부만 실패한 회차는 성공이다).</li>
 * </ul>
 * 회차 기록·백오프 기록·백오프 조회의 실패는 로그만 남기고 사진 수집을 막지 않는다.
 */
@Service
public class PhotoRun {

	private static final Logger log = LoggerFactory.getLogger(PhotoRun.class);

	/** 틱·1회 실행이 쓰는 워커 이름과 단일 실행 잠금 이름(수집과 다르다). */
	public static final String WORKER = "photos";

	public static final String LOCK_NAME = "auctionboss.photos";

	/** 회차 결과. {@code outcome}은 success·failed·blocked 중 하나다. */
	public record Result(RunOutcome outcome, String errorKind, String errorMessage, PhotosRunDetail detail) {
	}

	private record ErrorInfo(String kind, String message) {
	}

	private final ObjectProvider<AuctionSource> sources;

	private final PendingPhotoQuery pending;

	private final PhotoFileWriter files;

	private final PhotoSaveService saves;

	private final WorkerRunService runs;

	private final BackoffStore backoff;

	private final CollectorSettings settings;

	private final Sleeper sleeper;

	private final ServerClock clock;

	PhotoRun(ObjectProvider<AuctionSource> sources, PendingPhotoQuery pending, PhotoFileWriter files,
			PhotoSaveService saves, WorkerRunService runs, BackoffStore backoff, CollectorSettings settings,
			Sleeper sleeper, ServerClock clock) {
		this.sources = sources;
		this.pending = pending;
		this.files = files;
		this.saves = saves;
		this.runs = runs;
		this.backoff = backoff;
		this.settings = settings;
		this.sleeper = sleeper;
		this.clock = clock;
	}

	/** 설정 파일의 사진 설정으로 회차를 한다. 설정은 회차마다 읽는다. */
	public Result run() {
		return run(settings.photos());
	}

	public Result run(CollectorSettings.Photos config) {
		Long runId = safe("회차 시작 기록 실패 - 수집은 계속 진행합니다", () -> runs.start("photos").id(), null);
		int attempted = 0;
		int collected = 0;
		int empty = 0;
		int failed = 0;
		int requestsMade = 0;
		boolean blocked = false;
		ErrorInfo lastError = null;

		try {
			List<PendingPhoto> items = pending.find(config.maxItemsPerRun(), clock.now(), config.retryAfterHours(),
					settings.photosOnlyItemId().orElse(null));
			log.info("[photos] 수집 시작 - 대기 물건 {}건", items.size());
			if (!items.isEmpty()) {
				AuctionSource source = sources.getObject();
				for (int index = 0; index < items.size(); index++) {
					PendingPhoto item = items.get(index);
					if (index > 0) {
						sleeper.sleep(config.requestDelayMs());
					}
					// 수집 워커가 회차 도중 차단을 기록했을 수 있다: 요청 직전에 다시 확인한다.
					long remaining = backoffRemainingMs();
					if (remaining > 0) {
						log.warn("[photos] 다른 워커가 차단 백오프를 기록했습니다 - 남은 {}건은 이번 회차에서 요청하지 않습니다 (남은 시간 {}ms)",
								items.size() - index, remaining);
						break;
					}
					if (!item.lookupable()) {
						continue; // 조회 불가: 요청도 실패 기록도 하지 않는다
					}
					attempted++;
					try {
						FetchItemPhotosResult result = source
							.fetchItemPhotos(new PhotoLookupRef(item.courtCode(), item.internalCaseNo()));
						requestsMade += result.requestsMade();

						List<SavedPhoto> saved = new ArrayList<>();
						for (SourcePhoto photo : result.photos()) {
							PhotoFileWriter.Saved file = files.save(item.id(), photo.seq(), photo.base64());
							saved.add(new SavedPhoto(photo.seq(), file.filePath(), file.fileSize(), file.mimeType()));
						}
						if (!saved.isEmpty()) {
							saves.saveCollected(item.id(), saved, clock.now());
							collected++;
						}
						else {
							saves.markStatus(item.id(), PhotoStatus.EMPTY, clock.now());
							empty++;
						}
					}
					catch (RuntimeException e) {
						if (e instanceof SourceException se) {
							requestsMade += se.requestsMade();
						}
						lastError = describe(e);
						if (e instanceof SourceBlockedException) {
							// 차단은 물건이 아니라 IP의 문제: 물건을 failed로 기록하지 않고 공유 백오프를 걸고 회차를 끝낸다.
							Instant until = clock.now().plusMillis(settings.blockBackoffMs());
							safe("백오프 기록 실패 - 다음 회차에 차단이 다시 감지될 수 있습니다", () -> {
								backoff.extend(until);
								return null;
							}, null);
							log.error("[photos] 소스가 접근을 차단했습니다 ({}). {}ms 동안 사진 수집을 멈춥니다.", lastError.kind(),
									settings.blockBackoffMs(), e);
							blocked = true;
							break;
						}
						log.error("[photos] 물건 {} 사진 수집 실패 (다음 물건으로 넘어갑니다)", item.id(), e);
						failed++;
						safe("물건 " + item.id() + " 실패 상태 기록 실패", () -> {
							saves.markStatus(item.id(), PhotoStatus.FAILED, clock.now());
							return null;
						}, null);
					}
				}
			}
		}
		catch (RuntimeException e) {
			// 대기 물건 조회 실패 등 회차 전체를 못 돌린 경우
			ErrorInfo error = describe(e);
			log.error("[photos] 사진 회차가 실패했습니다 (다음 주기에 다시 시도합니다)", e);
			PhotosRunDetail detail = new PhotosRunDetail(attempted, collected, empty, failed, requestsMade);
			finish(runId, RunOutcome.FAILED, error.kind(), error.message(), detail);
			return new Result(RunOutcome.FAILED, error.kind(), error.message(), detail);
		}

		PhotosRunDetail detail = new PhotosRunDetail(attempted, collected, empty, failed, requestsMade);
		String kind = lastError == null ? null : lastError.kind();
		String message = lastError == null ? null : lastError.message();
		RunOutcome outcome;
		if (blocked) {
			outcome = RunOutcome.BLOCKED;
		}
		else if (attempted > 0 && failed == attempted) {
			outcome = RunOutcome.FAILED;
		}
		else {
			// 일부만 실패한 회차는 성공이다: 물건 단위 실패는 재시도 간격으로 따로 관리된다.
			outcome = RunOutcome.SUCCESS;
			kind = null;
			message = null;
			log.info("[photos] 회차 완료 - 시도 {}, 저장 {}, 사진 없음 {}, 실패 {}, 요청 {}", attempted, collected, empty, failed,
					requestsMade);
		}
		finish(runId, outcome, kind, message, detail);
		return new Result(outcome, kind, message, detail);
	}

	private static ErrorInfo describe(RuntimeException e) {
		String kind = e instanceof SourceException se ? se.kind() : e.getClass().getSimpleName();
		return new ErrorInfo(kind, e.getMessage());
	}

	/** 읽기 실패는 백오프 없음으로 보고 진행한다(수집 워커와 같은 원칙). */
	private long backoffRemainingMs() {
		return safe("백오프 조회 실패 - 백오프 없음으로 보고 진행합니다", () -> backoff.remainingMs(clock.now()), 0L);
	}

	/** {@code runId}가 없으면(시작 기록이 실패했으면) 종료 기록을 시도하지 않는다. */
	private void finish(Long runId, RunOutcome outcome, String errorKind, String errorMessage, PhotosRunDetail detail) {
		if (runId == null) {
			return;
		}
		safe("회차 종료 기록 실패 - 수집 결과에는 영향 없음", () -> {
			runs.finishRun(runId, outcome.dbValue(), errorKind, errorMessage, detail.toMap());
			return null;
		}, null);
	}

	private <T> T safe(String failureMessage, Supplier<T> action, T fallback) {
		try {
			return action.get();
		}
		catch (RuntimeException e) {
			log.error("[photos] {}", failureMessage, e);
			return fallback;
		}
	}

}
