package com.auctionboss.collect.photos;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;

import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDateTime;
import java.time.ZoneOffset;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import com.auctionboss.collect.run.BackoffStore;
import com.auctionboss.collect.run.CollectorSettings;
import com.auctionboss.collect.run.RunLock;
import com.auctionboss.collect.run.WorkerTicker;
import com.auctionboss.collect.source.AuctionSource;
import com.auctionboss.collect.source.FetchItemPhotosResult;
import com.auctionboss.collect.source.ResponseSchemaException;
import com.auctionboss.collect.source.RobotDetectedException;
import com.auctionboss.collect.source.SourcePhoto;
import com.auctionboss.collect.source.SourceRequestException;
import com.auctionboss.collect.source.WafBlockedException;
import com.auctionboss.common.time.ServerClock;
import com.auctionboss.photo.PhotoController;
import com.auctionboss.support.AbstractPhotoTest;
import com.auctionboss.support.FakeSourceConfig.FakeAuctionSource;
import com.auctionboss.support.FakeSourceConfig.FakeSleeper;
import com.auctionboss.support.MutableClock;
import com.auctionboss.worker.RunOutcome;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

/**
 * 6.3: 사진 회차 본체와 틱. TS {@code photos.test.ts}의 "회차 결과와 수치", "차단과 공유 백오프", "겹침과 기록 실패" 사례를 가짜 소스와
 * 실제 MySQL로 옮긴 것이다. 외부 요청은 없다(소스는 가짜, 대기는 기록만 하는 가짜 Sleeper).
 */
class PhotoRunTest extends AbstractPhotoTest {

	private static final Instant T0 = Instant.parse("2026-10-08T12:00:00Z");

	private static final CollectorSettings.Photos CONFIG = new CollectorSettings.Photos(999_000_000L, 5, 30_000, 24);

	private static final String GIF = "R0lGODlhAQABAAAAACw=";

	private static final String JPEG = "/9j/4AAQSkZJRgABAQAAAQABAAD/";

	private final AtomicInteger counter = new AtomicInteger();

	@Autowired
	PhotoRun run;

	@Autowired
	FakeAuctionSource source;

	@Autowired
	FakeSleeper sleeper;

	@Autowired
	MutableClock clock;

	@Autowired
	RunLock runLock;

	@Autowired
	ServerClock serverClock;

	@Autowired
	CollectorSettings settings;

	@Autowired
	PhotoController photoController;

	@BeforeEach
	void setUp() {
		clock.set(T0);
		source.reset();
		sleeper.reset();
	}

	// ------------------------------------------------------------------ 준비

	private long item(String internalCaseNo, String courtCode, String status, Instant attemptedAt) {
		String caseNo = "2026타경" + counter.incrementAndGet();
		jdbc.update("""
				INSERT INTO items (court, case_no, item_no, first_seen_at, last_seen_at, internal_case_no, court_code,
				                   photo_status, photo_attempted_at)
				VALUES ('서울중앙지방법원', ?, '1', ?, ?, ?, ?, ?, ?)""", caseNo, utc(T0), utc(T0), internalCaseNo,
				courtCode, status, attemptedAt == null ? null : utc(attemptedAt));
		return jdbc.queryForObject("SELECT id FROM items WHERE case_no = ?", Long.class, caseNo);
	}

	/** 내부 사건번호가 id 끝자리인 대기 물건. */
	private long pendingItem() {
		return item("2026013" + String.format("%07d", counter.get() + 1), "B000210", null, null);
	}

	private static LocalDateTime utc(Instant instant) {
		return LocalDateTime.ofInstant(instant, ZoneOffset.UTC);
	}

	private static FetchItemPhotosResult photos(int requests, String... base64) {
		SourcePhoto[] list = new SourcePhoto[base64.length];
		for (int i = 0; i < base64.length; i++) {
			list[i] = new SourcePhoto(i + 1, base64[i]);
		}
		return new FetchItemPhotosResult(List.of(list), requests);
	}

	private Map<String, Object> state(long itemId) {
		return jdbc.queryForMap("SELECT photo_status, photo_count, photo_attempted_at FROM items WHERE id = ?",
				itemId);
	}

	private List<Map<String, Object>> runRows() {
		return jdbc.queryForList(
				"SELECT id, worker, outcome, error_kind, error_message, detail FROM worker_runs ORDER BY id");
	}

	private Instant backoffUntil() {
		return backoffStore.until().orElse(null);
	}

	// ------------------------------------------------------------------ 회차 결과와 수치

	@Test
	void 세_건_시도에서_둘_저장_하나_사진_없음이면_success이고_수치가_기록된다() {
		long a = pendingItem();
		long b = pendingItem();
		long c = pendingItem(); // id가 큰 것부터 처리: c, b, a
		source.onPhotos(ref -> ref.internalCaseNo().equals(internalCaseNo(b)) ? photos(1)
				: photos(source.photoCalls().size() == 1 ? 2 : 1, GIF));

		PhotoRun.Result result = run.run(CONFIG);

		assertThat(result.outcome()).isEqualTo(RunOutcome.SUCCESS);
		assertThat(result.detail().toMap()).containsEntry("attempted", 3)
			.containsEntry("collected", 2)
			.containsEntry("empty", 1)
			.containsEntry("failed", 0)
			.containsEntry("requestsMade", 4);
		assertThat(state(c).get("photo_status")).isEqualTo("collected");
		assertThat(state(a).get("photo_status")).isEqualTo("collected");
		assertThat(state(b).get("photo_status")).isEqualTo("empty");
		assertThat(state(c).get("photo_count")).isEqualTo(1);
		Map<String, Object> row = runRows().get(0);
		assertThat(row.get("worker")).isEqualTo("photos");
		assertThat(row.get("outcome")).isEqualTo("success");
		assertThat(row.get("error_kind")).isNull();
		assertThat(row.get("detail").toString()).contains("\"attempted\": 3").contains("\"requestsMade\": 4");
		assertThat(jdbc.queryForObject("SELECT items_changed FROM worker_runs", Integer.class)).isNull();
	}

	@Test
	void 일부_물건만_실패하면_회차는_success이고_실패_수치가_남는다() {
		long first = pendingItem();
		long second = pendingItem();
		long third = pendingItem();
		source.onPhotos(ref -> {
			if (ref.internalCaseNo().equals(internalCaseNo(second))) {
				throw new ResponseSchemaException("형식 변경", List.of("x"));
			}
			return photos(1, GIF);
		});

		PhotoRun.Result result = run.run(CONFIG);

		assertThat(result.outcome()).isEqualTo(RunOutcome.SUCCESS);
		assertThat(result.errorKind()).isNull();
		assertThat(result.detail().toMap()).containsEntry("attempted", 3).containsEntry("collected", 2).containsEntry("failed", 1);
		assertThat(state(second).get("photo_status")).isEqualTo("failed");
		assertThat(state(first).get("photo_status")).isEqualTo("collected");
		assertThat(state(third).get("photo_status")).isEqualTo("collected");
	}

	@Test
	void 시도한_물건이_모두_차단이_아닌_오류로_실패하면_failed이고_마지막_오류가_남는다() {
		pendingItem();
		pendingItem();
		source.onPhotos(ref -> {
			throw new SourceRequestException("물건 상세 요청이 실패했습니다 (HTTP 500)", "http://loopback.invalid/");
		});

		PhotoRun.Result result = run.run(CONFIG);

		assertThat(result.outcome()).isEqualTo(RunOutcome.FAILED);
		assertThat(result.errorKind()).isEqualTo("SourceRequestError");
		assertThat(result.errorMessage()).contains("HTTP 500");
		Map<String, Object> row = runRows().get(0);
		assertThat(row.get("outcome")).isEqualTo("failed");
		assertThat(row.get("error_kind")).isEqualTo("SourceRequestError");
		assertThat(row.get("error_message").toString()).contains("HTTP 500");
		assertThat(backoffUntil()).as("일반 오류는 백오프를 걸지 않는다").isNull();
	}

	@Test
	void 대기_물건이_없으면_소스를_만들지도_부르지도_않고_success_0건으로_기록한다() {
		AtomicInteger created = new AtomicInteger();

		PhotoRun.Result result = runWithCountingSource(created, CONFIG);

		assertThat(result.outcome()).isEqualTo(RunOutcome.SUCCESS);
		assertThat(created).hasValue(0);
		assertThat(source.photoCalls()).isEmpty();
		assertThat(result.detail().toMap()).containsEntry("attempted", 0).containsEntry("requestsMade", 0);
		assertThat(runRows().get(0).get("detail").toString()).contains("\"attempted\": 0");
	}

	@Test
	void 회차_상한만큼만_요청하고_물건_사이에_requestDelayMs만큼_기다린다() {
		for (int i = 0; i < 10; i++) {
			pendingItem();
		}
		source.onPhotos(ref -> photos(1, GIF));

		run.run(new CollectorSettings.Photos(999_000_000L, 3, 30_000, 24));

		assertThat(source.photoCalls()).hasSize(3);
		// 요청 3번 -> 사이 간격 2번(첫 요청 앞에는 두지 않는다)
		assertThat(sleeper.sleeps()).containsExactly(30_000L, 30_000L);
	}

	@Test
	void 회차마다_새_소스를_받는다() {
		pendingItem();
		source.onPhotos(ref -> photos(1, GIF));
		AtomicInteger created = new AtomicInteger();

		runWithCountingSource(created, CONFIG);
		jdbc.update("UPDATE items SET photo_status = NULL, photo_attempted_at = NULL");
		runWithCountingSource(created, CONFIG);

		assertThat(created).hasValue(2);
	}

	@Test
	void 식별자가_없거나_빈_문자열인_물건은_요청도_실패_기록도_하지_않고_다음_회차에도_대기_목록에_남는다() {
		long empty = item("", "B000210", null, null);
		long noCourt = item("20260130001234", "", null, null);
		source.onPhotos(ref -> photos(1, GIF));

		PhotoRun.Result result = run.run(CONFIG);

		assertThat(source.photoCalls()).isEmpty();
		assertThat(result.outcome()).isEqualTo(RunOutcome.SUCCESS);
		assertThat(result.detail().attempted()).isZero();
		assertThat(state(empty).get("photo_status")).isNull();
		assertThat(state(noCourt).get("photo_status")).isNull();
		assertThat(pendingQuery.find(5, T0, 24)).extracting(PendingPhoto::id).containsExactlyInAnyOrder(empty, noCourt);
	}

	@Test
	void 사진_파일_저장이_던지면_그_물건만_실패로_기록한다() {
		long first = pendingItem();
		long second = pendingItem(); // 먼저 처리
		source.onPhotos(ref -> photos(1, GIF));
		doThrow(new IllegalStateException("디스크 오류")).when(fileWriter).save(eq(second), anyLong(), anyString());

		PhotoRun.Result result = run.run(CONFIG);

		assertThat(result.outcome()).isEqualTo(RunOutcome.SUCCESS);
		assertThat(state(second).get("photo_status")).isEqualTo("failed");
		assertThat(state(first).get("photo_status")).isEqualTo("collected");
		assertThat(result.detail().toMap()).containsEntry("failed", 1).containsEntry("collected", 1);
	}

	@Test
	void DB_저장이_던져도_그_물건만_실패로_기록하고_이미_쓴_파일은_남는다() {
		long id = pendingItem();
		source.onPhotos(ref -> photos(1, GIF));
		doThrow(new IllegalStateException("DB 오류")).when(photoSaves).saveCollected(eq(id), any(), any());

		PhotoRun.Result result = run.run(CONFIG);

		assertThat(result.outcome()).isEqualTo(RunOutcome.FAILED);
		assertThat(state(id).get("photo_status")).isEqualTo("failed");
		assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM item_photos", Integer.class)).isZero();
		assertThat(Files.exists(photosDir().resolve(id + "/1.gif"))).isTrue();
	}

	@Test
	void 저장한_사진_파일을_사진_파일_API가_같은_바이트로_내려준다() throws Exception {
		long id = pendingItem();
		source.onPhotos(ref -> photos(1, JPEG, GIF));

		run.run(CONFIG);

		MockMvc mvc = MockMvcBuilders.standaloneSetup(photoController).build();
		MvcResult first = mvc.perform(get("/api/photos/" + id + "/1")).andReturn();
		MvcResult second = mvc.perform(get("/api/photos/" + id + "/2")).andReturn();
		assertThat(first.getResponse().getStatus()).isEqualTo(200);
		assertThat(first.getResponse().getContentType()).isEqualTo("image/jpeg");
		assertThat(first.getResponse().getContentAsByteArray()).isEqualTo(Files.readAllBytes(photosDir().resolve(id + "/1.jpg")));
		assertThat(first.getResponse().getContentAsByteArray()).isEqualTo(java.util.Base64.getDecoder().decode(JPEG));
		assertThat(second.getResponse().getContentType()).isEqualTo("image/gif");
		assertThat(second.getResponse().getContentAsByteArray()).isEqualTo(java.util.Base64.getDecoder().decode(GIF));
	}

	// ------------------------------------------------------------------ 차단과 공유 백오프

	@Test
	void 두_번째_물건에서_차단되면_blocked로_끝나고_남은_물건은_요청하지_않으며_백오프를_기록한다() {
		long a = pendingItem();
		long b = pendingItem();
		long c = pendingItem(); // 처리 순서 c, b, a
		AtomicInteger n = new AtomicInteger();
		source.onPhotos(ref -> {
			if (n.incrementAndGet() == 2) {
				throw new RobotDetectedException("차단", null);
			}
			return photos(1, GIF);
		});

		PhotoRun.Result result = run.run(CONFIG);

		assertThat(result.outcome()).isEqualTo(RunOutcome.BLOCKED);
		assertThat(result.errorKind()).isEqualTo("RobotDetectedError");
		assertThat(source.photoCalls()).hasSize(2);
		assertThat(backoffUntil()).isEqualTo(T0.plusMillis(settings.blockBackoffMs()));
		assertThat(state(c).get("photo_status")).isEqualTo("collected");
		assertThat(state(b).get("photo_status")).as("차단된 물건은 실패로 적지 않는다").isNull();
		assertThat(state(b).get("photo_attempted_at")).isNull();
		assertThat(state(a).get("photo_status")).as("요청하지 않은 물건").isNull();
		Map<String, Object> row = runRows().get(0);
		assertThat(row.get("outcome")).isEqualTo("blocked");
		assertThat(row.get("error_kind")).isEqualTo("RobotDetectedError");
	}

	@Test
	void WAF_차단도_같은_방식으로_blocked_처리한다() {
		pendingItem();
		source.onPhotos(ref -> {
			throw new WafBlockedException("waf", "<html>");
		});

		PhotoRun.Result result = run.run(CONFIG);

		assertThat(result.outcome()).isEqualTo(RunOutcome.BLOCKED);
		assertThat(result.errorKind()).isEqualTo("WafBlockedError");
		assertThat(backoffUntil()).isEqualTo(T0.plusMillis(settings.blockBackoffMs()));
	}

	@Test
	void 일반_오류는_메시지에_HTTP가_있어도_백오프를_쓰지_않는다() {
		pendingItem();
		pendingItem();
		AtomicInteger n = new AtomicInteger();
		source.onPhotos(ref -> {
			if (n.incrementAndGet() == 1) {
				throw new SourceRequestException("HTTP 429", "http://loopback.invalid/");
			}
			return photos(1, GIF);
		});

		run.run(CONFIG);

		assertThat(backoffUntil()).isNull();
	}

	@Test
	void 요청_수는_실패한_호출이_실어_보낸_값까지_합산한다() {
		pendingItem();
		pendingItem();
		AtomicInteger n = new AtomicInteger();
		source.onPhotos(ref -> {
			if (n.incrementAndGet() == 1) {
				throw com.auctionboss.collect.source.SourceException
					.attachRequestsMade(new SourceRequestException("HTTP 500", "http://loopback.invalid/"), 3);
			}
			return photos(2, GIF);
		});

		PhotoRun.Result result = run.run(CONFIG);

		assertThat(result.detail().requestsMade()).isEqualTo(5);
	}

	@Test
	void 회차_중간에_다른_워커가_백오프를_쓰면_다음_물건부터_멈추고_회차는_success다() {
		pendingItem();
		pendingItem();
		pendingItem();
		source.onPhotos(ref -> {
			backoffStore.extend(T0.plusSeconds(60)); // 수집기가 차단을 기록
			return photos(1, GIF);
		});

		PhotoRun.Result result = run.run(CONFIG);

		assertThat(source.photoCalls()).hasSize(1);
		assertThat(result.outcome()).as("이 워커의 실패가 아니다").isEqualTo(RunOutcome.SUCCESS);
		assertThat(result.detail().toMap()).containsEntry("attempted", 1).containsEntry("collected", 1);
	}

	@Test
	void 지난_백오프_값은_무시한다() {
		pendingItem();
		backoffStore.extend(T0.minusSeconds(1));
		source.onPhotos(ref -> photos(1, GIF));

		run.run(CONFIG);

		assertThat(source.photoCalls()).hasSize(1);
	}

	@Test
	void 백오프_조회가_던져도_로그만_남기고_수집은_진행한다() {
		pendingItem();
		source.onPhotos(ref -> photos(1, GIF));
		doThrow(new IllegalStateException("db down")).when(backoffStore).remainingMs(any());

		PhotoRun.Result result = run.run(CONFIG);

		assertThat(result.outcome()).isEqualTo(RunOutcome.SUCCESS);
		assertThat(source.photoCalls()).hasSize(1);
	}

	// ------------------------------------------------------------------ 틱: 겹침, 백오프 건너뜀

	private WorkerTicker ticker() {
		return new WorkerTicker("photos", "auctionboss.photos", runLock, () -> backoffStore.remainingMs(clock.instant()),
				reason -> workerRuns.recordSkipped("photos", reason), () -> run.run(CONFIG));
	}

	@Test
	void 실행_중에_틱이_또_오면_overlap으로_기록하고_소스를_다시_부르지_않는다() throws Exception {
		pendingItem();
		CountDownLatch entered = new CountDownLatch(1);
		CountDownLatch release = new CountDownLatch(1);
		source.onPhotos(ref -> {
			entered.countDown();
			try {
				assertThat(release.await(20, TimeUnit.SECONDS)).isTrue();
			}
			catch (InterruptedException e) {
				Thread.currentThread().interrupt();
			}
			return photos(1, GIF);
		});
		WorkerTicker ticker = ticker();
		try {
			ticker.tick();
			assertThat(entered.await(20, TimeUnit.SECONDS)).isTrue();
			ticker.tick();
			release.countDown();
			assertThat(ticker.awaitIdle(Duration.ofSeconds(20))).isTrue();
		}
		finally {
			release.countDown();
			ticker.shutdown(Duration.ofSeconds(5));
		}

		assertThat(source.photoCalls()).hasSize(1);
		List<Map<String, Object>> rows = runRows();
		assertThat(rows).extracting(r -> r.get("outcome")).containsExactlyInAnyOrder("success", "skipped");
		assertThat(rows).filteredOn(r -> "skipped".equals(r.get("outcome"))).extracting(r -> r.get("error_kind"))
			.containsExactly("overlap");
		assertThat(rows).extracting(r -> r.get("worker")).containsOnly("photos");
	}

	@Test
	void 백오프_중_틱은_소스를_부르지_않고_backoff로_기록한다() {
		pendingItem();
		backoffStore.extend(T0.plusSeconds(60));
		source.onPhotos(ref -> photos(1, GIF));
		WorkerTicker ticker = ticker();
		try {
			ticker.tick();
			assertThat(ticker.awaitIdle(Duration.ofSeconds(20))).isTrue();
		}
		finally {
			ticker.shutdown(Duration.ofSeconds(5));
		}

		assertThat(source.photoCalls()).isEmpty();
		List<Map<String, Object>> rows = runRows();
		assertThat(rows).hasSize(1);
		assertThat(rows.get(0).get("outcome")).isEqualTo("skipped");
		assertThat(rows.get(0).get("error_kind")).isEqualTo("backoff");
	}

	// ------------------------------------------------------------------ 기록 실패

	@Test
	void 회차_시작과_종료_기록이_던져도_사진_저장은_진행되고_회차는_정상_종료한다() {
		long a = pendingItem();
		long b = pendingItem();
		source.onPhotos(ref -> photos(1, GIF));
		doThrow(new IllegalStateException("db down")).when(workerRuns).start(anyString());
		doThrow(new IllegalStateException("db down")).when(workerRuns).finishRun(anyLong(), anyString(), any(), any(), any());

		PhotoRun.Result result = run.run(CONFIG);

		assertThat(result.outcome()).isEqualTo(RunOutcome.SUCCESS);
		assertThat(state(a).get("photo_status")).isEqualTo("collected");
		assertThat(state(b).get("photo_status")).isEqualTo("collected");
		assertThat(runRows()).isEmpty();
	}

	@Test
	void 종료_기록만_던져도_회차_결과는_그대로다() {
		pendingItem();
		source.onPhotos(ref -> photos(1, GIF));
		doThrow(new IllegalStateException("db down")).when(workerRuns).finishRun(anyLong(), anyString(), any(), any(), any());

		PhotoRun.Result result = run.run(CONFIG);

		assertThat(result.outcome()).isEqualTo(RunOutcome.SUCCESS);
		assertThat(runRows().get(0).get("outcome")).as("종료 기록이 없으면 진행 중으로 남는다").isEqualTo("running");
	}

	@Test
	void 대기_물건_조회가_던지면_회차를_failed로_기록하고_다음_회차는_정상_시도한다() {
		pendingItem();
		source.onPhotos(ref -> photos(1, GIF));
		doThrow(new IllegalStateException("query failed")).doCallRealMethod().when(pendingQuery).find(anyLong(), any(), anyLong());

		PhotoRun.Result failed = run.run(CONFIG);
		PhotoRun.Result next = run.run(CONFIG);

		assertThat(failed.outcome()).isEqualTo(RunOutcome.FAILED);
		assertThat(failed.errorMessage()).isEqualTo("query failed");
		assertThat(failed.errorKind()).isEqualTo("IllegalStateException");
		assertThat(runRows().get(0).get("outcome")).isEqualTo("failed");
		assertThat(runRows().get(0).get("error_message")).isEqualTo("query failed");
		assertThat(next.outcome()).isEqualTo(RunOutcome.SUCCESS);
		assertThat(source.photoCalls()).hasSize(1);
	}

	// ------------------------------------------------------------------ 헬퍼

	private String internalCaseNo(long itemId) {
		return jdbc.queryForObject("SELECT internal_case_no FROM items WHERE id = ?", String.class, itemId);
	}

	/** 소스를 받을 때마다 세는 {@code ObjectProvider}로 만든 회차(회차마다 새 소스를 받는지, 대기가 없으면 받지 않는지 본다). */
	@SuppressWarnings("unchecked")
	private PhotoRun.Result runWithCountingSource(AtomicInteger created, CollectorSettings.Photos config) {
		ObjectProvider<AuctionSource> provider = mock(ObjectProvider.class);
		when(provider.getObject()).thenAnswer(call -> {
			created.incrementAndGet();
			return source;
		});
		PhotoRun counting = new PhotoRun(provider, pendingQuery, fileWriter, photoSaves, workerRuns, backoffStore,
				settings, sleeper, serverClock);
		return counting.run(config);
	}

}
