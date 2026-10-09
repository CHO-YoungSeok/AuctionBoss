package com.auctionboss.collect.collector;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;

import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.function.Supplier;
import java.util.stream.Stream;

import com.auctionboss.collect.run.BackoffStore;
import com.auctionboss.collect.run.CollectorSettings;
import com.auctionboss.collect.source.CollectScope;
import com.auctionboss.collect.source.CourtRef;
import com.auctionboss.collect.source.FetchActiveItemsResult;
import com.auctionboss.collect.source.ResponseSchemaException;
import com.auctionboss.collect.source.RobotDetectedException;
import com.auctionboss.collect.source.SourceException;
import com.auctionboss.collect.source.SourceItem;
import com.auctionboss.collect.source.SourceRequestException;
import com.auctionboss.collect.source.WafBlockedException;
import com.auctionboss.support.AbstractMySqlTest;
import com.auctionboss.support.FakeSourceConfig;
import com.auctionboss.support.FakeSourceConfig.FakeAuctionSource;
import com.auctionboss.support.FixedClockConfig;
import com.auctionboss.support.MutableClock;
import com.auctionboss.worker.RunOutcome;
import com.auctionboss.worker.WorkerRunService;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.MethodSource;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.context.annotation.Import;
import org.springframework.test.context.TestPropertySource;
import org.springframework.test.context.bean.override.mockito.MockitoSpyBean;

/**
 * 4.5: 수집 회차 본체. TS {@code collector.test.ts}의 "회차 기록 연동", "로테이션 연동", "기록 실패가 수집을 막지 않는다" 사례를 가짜
 * 소스로 옮긴 것이다. 틱(겹침·백오프 건너뜀)은 5장의 몫이다.
 */
@Import({ FixedClockConfig.class, FakeSourceConfig.class })
@TestPropertySource(properties = "auctionboss.collector.block-backoff-ms=60000")
class CollectorRunTest extends AbstractMySqlTest {

	private static final Instant T0 = Instant.parse("2026-10-08T00:00:00Z");

	private static final CourtRef A = new CourtRef("서울중앙지방법원", "B000210");

	private static final CourtRef B = new CourtRef("서울동부지방법원", "B000211");

	private static final CourtRef C = new CourtRef("서울서부지방법원", "B000215");

	@Autowired
	CollectorRun run;

	@Autowired
	FakeAuctionSource source;

	@Autowired
	MutableClock clock;

	@Autowired
	BackoffStore backoff;

	@MockitoSpyBean
	RotationStore rotation;

	@MockitoSpyBean
	WorkerRunService runs;

	@MockitoSpyBean
	ItemUpsertService upsert;

	@BeforeEach
	void setUp() {
		clock.set(T0);
		source.reset();
	}

	private static CollectorSettings.Scope scope(int maxCourts, long maxRequests, CourtRef... courts) {
		return new CollectorSettings.Scope(List.of(courts), maxCourts, maxRequests);
	}

	private static SourceItem item(String itemNo) {
		return TestItems.item("서울중앙지방법원", "2025타경1", itemNo, "서울특별시 관악구 신림동 1-1", 400_000_000L, 1L, "2026-10-01", "진행");
	}

	private static FetchActiveItemsResult result(int pages, SourceItem... items) {
		return new FetchActiveItemsResult(List.of(items), pages);
	}

	private List<Map<String, Object>> runRows() {
		return jdbc.queryForList("""
				SELECT id, worker, outcome, error_kind, error_message, detail, items_changed,
				       DATE_FORMAT(started_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS started_at,
				       DATE_FORMAT(finished_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS finished_at
				FROM worker_runs ORDER BY id""");
	}

	private int itemCount() {
		return jdbc.queryForObject("SELECT COUNT(*) FROM items", Integer.class);
	}

	private List<String> calledCodes() {
		return source.searches().stream().map(s -> s.courts().get(0).courtCode()).toList();
	}

	@Test
	void 정상_회차는_success로_기록되고_detail에_여섯_수치가_담긴다() {
		source.onSearch(s -> result(5, item("1"), item("2"), item("3")));

		CollectorRun.Result result = run.run(scope(1, 999, A));

		assertThat(result.outcome()).isEqualTo(RunOutcome.SUCCESS);
		assertThat(result.detail().toMap()).containsEntry("targetCourts", List.of("서울중앙지방법원"))
			.containsEntry("pagesRequested", 5)
			.containsEntry("itemsFetched", 3)
			.containsEntry("inserted", 3)
			.containsEntry("updated", 0)
			.containsEntry("changed", 0);
		Map<String, Object> row = runRows().get(0);
		assertThat(row.get("worker")).isEqualTo("collector");
		assertThat(row.get("outcome")).isEqualTo("success");
		assertThat(row.get("error_kind")).isNull();
		assertThat(row.get("items_changed")).isEqualTo(0);
		assertThat(row.get("detail").toString()).contains("\"pagesRequested\": 5").contains("\"inserted\": 3");
		assertThat(itemCount()).isEqualTo(3);
	}

	@Test
	void pagesRequested는_소스가_돌려준_값을_기록한다() {
		source.onSearch(s -> result(7));

		run.run(scope(1, 999, A));

		assertThat(runRows().get(0).get("detail").toString()).contains("\"pagesRequested\": 7");
	}

	static Stream<Supplier<SourceException>> blockedErrors() {
		return Stream.of(() -> new RobotDetectedException("로봇탐지 차단", null),
				() -> new WafBlockedException("WAF 차단", "<html>차단 페이지</html>"));
	}

	@ParameterizedTest
	@MethodSource("blockedErrors")
	void 차단_오류는_failed가_아니라_blocked로_기록되고_error_kind가_오류_이름이다(Supplier<SourceException> error) {
		SourceException thrown = error.get();
		source.onSearch(s -> {
			throw error.get();
		});

		CollectorRun.Result result = run.run(scope(1, 999, A));

		assertThat(result.outcome()).isEqualTo(RunOutcome.BLOCKED);
		Map<String, Object> row = runRows().get(0);
		assertThat(row.get("outcome")).isEqualTo("blocked");
		assertThat(row.get("error_kind")).isEqualTo(thrown.kind());
		assertThat(row.get("error_message")).isEqualTo(thrown.getMessage());
	}

	static Stream<Supplier<SourceException>> failedErrors() {
		return Stream.of(() -> new ResponseSchemaException("응답 형식이 바뀜", List.of("필드 x 누락")),
				() -> new SourceRequestException("네트워크 오류", "https://example.test", 500, null));
	}

	@ParameterizedTest
	@MethodSource("failedErrors")
	void 형식_오류와_요청_실패는_failed로_기록되고_백오프를_걸지_않는다(Supplier<SourceException> error) {
		SourceException thrown = error.get();
		source.onSearch(s -> {
			throw error.get();
		});

		CollectorRun.Result result = run.run(scope(1, 999, A));

		assertThat(result.outcome()).isEqualTo(RunOutcome.FAILED);
		Map<String, Object> row = runRows().get(0);
		assertThat(row.get("outcome")).isEqualTo("failed");
		assertThat(row.get("error_kind")).isEqualTo(thrown.kind());
		assertThat(backoff.until()).isEmpty();
	}

	@Test
	void 소스_오류가_아닌_예외도_failed로_기록하고_밖으로_던지지_않는다() {
		source.onSearch(s -> {
			throw new IllegalStateException("예상 못한 오류");
		});

		CollectorRun.Result result = run.run(scope(1, 999, A));

		assertThat(result.outcome()).isEqualTo(RunOutcome.FAILED);
		assertThat(runRows().get(0).get("error_kind")).isEqualTo("IllegalStateException");
		assertThat(backoff.until()).isEmpty();
	}

	@Test
	void 차단_회차의_detail에_오류가_실어_보낸_요청_수가_남는다() {
		source.onSearch(s -> {
			throw SourceException.attachRequestsMade(new RobotDetectedException("3페이지째 차단", null), 3);
		});

		CollectorRun.Result result = run.run(scope(1, 999, A));

		assertThat(result.detail().pagesRequested()).isEqualTo(3);
		assertThat(runRows().get(0).get("detail").toString()).contains("\"pagesRequested\": 3")
			.contains("\"itemsFetched\": 0");
	}

	@Test
	void 요청_수가_실리지_않은_오류는_0으로_남는다() {
		source.onSearch(s -> {
			throw new RobotDetectedException("차단", null);
		});

		CollectorRun.Result result = run.run(scope(1, 999, A));

		assertThat(result.detail().toMap()).containsEntry("pagesRequested", 0)
			.containsEntry("itemsFetched", 0)
			.containsEntry("targetCourts", List.of("서울중앙지방법원"));
	}

	@Test
	void 차단되면_공유_백오프를_지금_더하기_설정_길이로_늘린다() {
		source.onSearch(s -> {
			throw new RobotDetectedException("차단", null);
		});
		clock.set(T0.plusSeconds(30));

		run.run(scope(1, 999, A));

		assertThat(backoff.until()).contains(T0.plusSeconds(30).plusMillis(60_000));
	}

	@Test
	void 더_늦은_백오프가_이미_있으면_차단이_그것을_줄이지_않는다() {
		backoff.extend(T0.plusSeconds(7200));
		source.onSearch(s -> {
			throw new RobotDetectedException("차단", null);
		});

		run.run(scope(1, 999, A));

		assertThat(backoff.until()).contains(T0.plusSeconds(7200));
	}

	@Test
	void 여러_회차에_걸쳐_법원이_순환하고_회차_종료_때마다_다음_위치가_저장된다() {
		source.onSearch(s -> result(1));
		CollectorSettings.Scope scope = scope(1, 999, A, B, C);

		assertThat(rotation.get()).isNull();
		run.run(scope);
		assertThat(rotation.get()).isEqualTo("B000211");
		run.run(scope);
		assertThat(rotation.get()).isEqualTo("B000215");
		run.run(scope);
		assertThat(rotation.get()).isEqualTo("B000210");

		assertThat(calledCodes()).containsExactly("B000210", "B000211", "B000215");
	}

	@Test
	void 차단되면_위치를_전진시키지_않고_같은_회차에서_다음_법원으로_넘어가지_않는다() {
		rotation.set("B000211");
		source.onSearch(s -> {
			throw new RobotDetectedException("차단", null);
		});

		run.run(scope(3, 999, A, B, C));

		assertThat(calledCodes()).containsExactly("B000211");
		assertThat(rotation.get()).isEqualTo("B000211");
	}

	@Test
	void 백오프가_끝난_뒤_회차는_차단됐던_법원부터_재개한다() {
		rotation.set("B000211");
		source.onSearch(s -> {
			throw new RobotDetectedException("차단", null);
		});
		run.run(scope(1, 999, A, B, C));
		clock.set(T0.plusSeconds(3600));
		run.run(scope(1, 999, A, B, C));

		assertThat(calledCodes()).containsExactly("B000211", "B000211");
	}

	@Test
	void 두_번째_법원에서_실패하면_첫_법원_물건은_저장하지_않고_위치는_실패한_법원이다() {
		source.onSearch(s -> {
			if (s.courts().get(0).courtCode().equals("B000211")) {
				throw new SourceRequestException("연결 끊김", "http://x/");
			}
			return result(2, item("1"));
		});

		CollectorRun.Result result = run.run(scope(2, 999, A, B, C));

		assertThat(result.outcome()).isEqualTo(RunOutcome.FAILED);
		assertThat(itemCount()).isZero();
		assertThat(rotation.get()).isEqualTo("B000211");
		assertThat(result.detail().targetCourts()).containsExactly("서울중앙지방법원", "서울동부지방법원");
		assertThat(result.detail().pagesRequested()).isEqualTo(2);
		assertThat(result.detail().itemsFetched()).isEqualTo(1);
	}

	@Test
	void 요청_상한을_넘으면_다음_법원을_시작하지_않되_이미_시작한_법원은_끊지_않는다() {
		source.onSearch(s -> result(2));

		CollectorRun.Result result = run.run(scope(3, 2, A, B, C));

		assertThat(calledCodes()).containsExactly("B000210");
		assertThat(result.outcome()).isEqualTo(RunOutcome.SUCCESS);
		assertThat(result.detail().targetCourts()).containsExactly("서울중앙지방법원");
		assertThat(result.detail().pagesRequested()).isEqualTo(2);
		assertThat(rotation.get()).isEqualTo("B000211");
	}

	@Test
	void 누적_요청_수가_상한_바로_아래면_다음_법원을_시작하고_상한에_닿으면_그_다음부터_멈춘다() {
		source.onSearch(s -> result(1));

		run.run(scope(3, 2, A, B, C));

		assertThat(calledCodes()).containsExactly("B000210", "B000211");
		assertThat(rotation.get()).isEqualTo("B000215");
	}

	@Test
	void 첫_법원은_상한과_무관하게_항상_시도한다() {
		source.onSearch(s -> result(50));

		run.run(scope(2, 1, A, B));

		assertThat(calledCodes()).containsExactly("B000210");
	}

	@Test
	void 저장이_실패하면_failed이고_물건은_없고_위치는_이번_회차_대상_다음_법원으로_전진한다() {
		source.onSearch(s -> result(1, item("1")));
		doThrow(new IllegalStateException("이력 INSERT 실패")).when(upsert).upsertItems(any(), any());

		CollectorRun.Result result = run.run(scope(2, 999, A, B, C));

		assertThat(result.outcome()).isEqualTo(RunOutcome.FAILED);
		assertThat(result.errorKind()).isEqualTo("IllegalStateException");
		assertThat(itemCount()).isZero();
		assertThat(rotation.get()).isEqualTo("B000215");
		assertThat(backoff.until()).isEmpty();
	}

	@Test
	void 회차_시작과_종료_기록이_실패해도_물건은_저장되고_회차는_정상_종료한다() {
		doThrow(new IllegalStateException("회차 기록 DB 다운")).when(runs).start(anyString());
		source.onSearch(s -> result(1, item("1"), item("2")));

		CollectorRun.Result result = run.run(scope(1, 999, A));

		assertThat(result.outcome()).isEqualTo(RunOutcome.SUCCESS);
		assertThat(itemCount()).isEqualTo(2);
		assertThat(runRows()).isEmpty();
	}

	@Test
	void 시작_기록이_실패하면_종료_기록은_시도하지_않는다() {
		doThrow(new IllegalStateException("회차 기록 DB 다운")).when(runs).start(anyString());
		source.onSearch(s -> result(0));

		run.run(scope(1, 999, A));

		verify(runs, never()).finishRun(anyLong(), anyString(), any(), any(), any());
	}

	@Test
	void 종료_기록이_실패해도_수집은_정상_종료하고_그_회차는_running으로_남는다() {
		doThrow(new IllegalStateException("회차 기록 DB 다운")).when(runs).finishRun(anyLong(), anyString(), any(), any(), any());
		source.onSearch(s -> result(1, item("1")));

		CollectorRun.Result result = run.run(scope(1, 999, A));

		assertThat(result.outcome()).isEqualTo(RunOutcome.SUCCESS);
		assertThat(itemCount()).isEqualTo(1);
		assertThat(runRows().get(0).get("outcome")).isEqualTo("running");
	}

	@Test
	void 차단_종료_기록이_실패해도_백오프는_건다() {
		doThrow(new IllegalStateException("회차 기록 DB 다운")).when(runs).finishRun(anyLong(), anyString(), any(), any(), any());
		source.onSearch(s -> {
			throw new WafBlockedException("차단", "");
		});

		run.run(scope(1, 999, A));

		assertThat(backoff.until()).isPresent();
	}

	@Test
	void 로테이션_위치를_못_읽으면_처음부터_시작한다() {
		doThrow(new IllegalStateException("DB 오류")).when(rotation).get();
		source.onSearch(s -> result(1));

		CollectorRun.Result result = run.run(scope(1, 999, A, B, C));

		assertThat(result.outcome()).isEqualTo(RunOutcome.SUCCESS);
		assertThat(calledCodes()).containsExactly("B000210");
	}

	@Test
	void 로테이션_위치를_못_써도_회차는_정상_종료한다() {
		doThrow(new IllegalStateException("DB 오류")).when(rotation).set(anyString());
		source.onSearch(s -> result(1, item("1")));

		CollectorRun.Result result = run.run(scope(1, 999, A, B));

		assertThat(result.outcome()).isEqualTo(RunOutcome.SUCCESS);
		assertThat(itemCount()).isEqualTo(1);
		assertThat(runRows().get(0).get("outcome")).isEqualTo("success");
	}

}
