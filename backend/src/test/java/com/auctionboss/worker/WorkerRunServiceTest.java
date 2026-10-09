package com.auctionboss.worker;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import com.auctionboss.support.AbstractMySqlTest;
import com.auctionboss.support.FixedClockConfig;
import com.auctionboss.support.MutableClock;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.context.annotation.Import;
import org.springframework.test.context.TestPropertySource;

/** 4.4: 워커가 쓰는 내부 종료 메서드와 건너뜀 기록. API 경로는 {@code WorkerRunApiTest}가 그대로 확인한다. */
@Import(FixedClockConfig.class)
@TestPropertySource(properties = "auctionboss.worker.max-runs-per-worker=3")
class WorkerRunServiceTest extends AbstractMySqlTest {

	private static final Instant T0 = Instant.parse("2026-10-08T00:00:00Z");

	@Autowired
	WorkerRunService service;

	@Autowired
	MutableClock clock;

	@BeforeEach
	void resetClock() {
		clock.set(T0);
	}

	private List<Map<String, Object>> rows() {
		return jdbc.queryForList("""
				SELECT id, worker, DATE_FORMAT(started_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS started_at,
				       DATE_FORMAT(finished_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS finished_at, outcome, error_kind,
				       error_message, detail, items_changed,
				       DATE_FORMAT(created_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS created_at
				FROM worker_runs ORDER BY id""");
	}

	@Test
	void 건너뜀_행은_시작과_종료가_같고_error_kind가_사유이다() {
		clock.set(T0.plusSeconds(90));

		service.recordSkipped("collector", "overlap");
		service.recordSkipped("photos", "backoff");

		List<Map<String, Object>> rows = rows();
		assertThat(rows).hasSize(2);
		Map<String, Object> first = rows.get(0);
		assertThat(first.get("worker")).isEqualTo("collector");
		assertThat(first.get("outcome")).isEqualTo("skipped");
		assertThat(first.get("error_kind")).isEqualTo("overlap");
		assertThat(first.get("started_at")).isEqualTo("2026-10-08T00:01:30.000000Z");
		assertThat(first.get("finished_at")).isEqualTo(first.get("started_at"));
		assertThat(first.get("created_at")).isEqualTo(first.get("started_at"));
		assertThat(first.get("error_message")).isNull();
		assertThat(first.get("detail")).isNull();
		assertThat(first.get("items_changed")).isNull();
		assertThat(rows.get(1).get("error_kind")).isEqualTo("backoff");
		assertThat(rows.get(1).get("worker")).isEqualTo("photos");
	}

	@Test
	void 건너뜀_기록도_워커별_보관_상한을_넘는_오래된_행을_지운다() {
		for (int i = 0; i < 5; i++) {
			clock.set(T0.plusSeconds(i));
			service.recordSkipped("collector", "overlap");
		}
		service.recordSkipped("photos", "backoff");

		List<Map<String, Object>> collector = rows().stream().filter(r -> r.get("worker").equals("collector")).toList();
		assertThat(collector).hasSize(3);
		assertThat(collector.get(0).get("started_at")).isEqualTo("2026-10-08T00:00:02.000000Z");
		assertThat(rows().stream().filter(r -> r.get("worker").equals("photos"))).hasSize(1);
	}

	@Test
	void finishRun은_API와_같은_열을_채우고_changed를_items_changed로_옮긴다() {
		long id = service.start("collector").id();
		clock.set(T0.plusSeconds(5));
		Map<String, Object> detail = new LinkedHashMap<>();
		detail.put("targetCourts", List.of("서울중앙지방법원"));
		detail.put("pagesRequested", 2);
		detail.put("itemsFetched", 40);
		detail.put("inserted", 3);
		detail.put("updated", 37);
		detail.put("changed", 5);

		service.finishRun(id, "success", null, null, detail);

		Map<String, Object> row = rows().get(0);
		assertThat(row.get("outcome")).isEqualTo("success");
		assertThat(row.get("finished_at")).isEqualTo("2026-10-08T00:00:05.000000Z");
		assertThat(row.get("items_changed")).isEqualTo(5);
		assertThat(row.get("detail").toString()).contains("\"changed\": 5").contains("서울중앙지방법원");
		assertThat(row.get("error_kind")).isNull();
	}

	@Test
	void finishRun에_detail이_없으면_items_changed도_없고_오류_열이_채워진다() {
		long id = service.start("collector").id();

		service.finishRun(id, "blocked", "RobotDetectedError", "차단", null);

		Map<String, Object> row = rows().get(0);
		assertThat(row.get("outcome")).isEqualTo("blocked");
		assertThat(row.get("error_kind")).isEqualTo("RobotDetectedError");
		assertThat(row.get("error_message")).isEqualTo("차단");
		assertThat(row.get("detail")).isNull();
		assertThat(row.get("items_changed")).isNull();
	}

	@Test
	void 없는_회차를_종료하면_WorkerRunNotFoundException이다() {
		assertThatThrownBy(() -> service.finishRun(987_654, "success", null, null, null))
			.isInstanceOf(WorkerRunNotFoundException.class);
	}

}
