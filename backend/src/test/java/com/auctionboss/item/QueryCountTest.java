package com.auctionboss.item;

import static com.auctionboss.support.TestData.item;
import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;

import java.time.Instant;
import java.time.LocalDate;
import java.util.List;

import com.auctionboss.analysis.Analysis;
import com.auctionboss.analysis.AnalysisRepository;
import com.auctionboss.bookmark.Bookmark;
import com.auctionboss.history.ChangeKind;
import com.auctionboss.history.ItemChange;
import com.auctionboss.history.ItemChangeRepository;
import com.auctionboss.support.AbstractMySqlTest;
import com.auctionboss.support.FixedClockConfig;
import jakarta.persistence.EntityManager;
import jakarta.persistence.EntityManagerFactory;
import org.hibernate.SessionFactory;
import org.hibernate.stat.Statistics;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.context.annotation.Import;
import org.springframework.test.context.TestPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.transaction.support.TransactionTemplate;
import tools.jackson.databind.json.JsonMapper;

/**
 * 8.2: 읽기 API 1회가 실행하는 SQL 문 수를 고정해 N+1 회귀를 막는다.
 *
 * <p>
 * 측정은 Hibernate {@code Statistics.getPrepareStatementCount()}로 한다. 새 의존성이 필요 없고, 이미 쓰는
 * Hibernate가 실제로 JDBC에 준비시킨 문장 수를 세므로 지연 로딩이 뒤에서 내는 쿼리도 빠짐없이 잡힌다.
 * 통계는 이 테스트 컨텍스트에서만 켠다(아래 {@code generate_statistics}).
 *
 * <p>
 * 행 수에 비례하지 않음은 같은 요청을 물건 수 4건과 30건에서 각각 재서 같은 값인지로 확인한다.
 */
@AutoConfigureMockMvc
@Import(FixedClockConfig.class)
@TestPropertySource(properties = { "spring.jpa.properties.hibernate.generate_statistics=true",
		"auctionboss.analysis.reanalysis-cooldown-hours=24" })
class QueryCountTest extends AbstractMySqlTest {

	private static final JsonMapper JSON = JsonMapper.builder().build();

	private static final Instant OLD = Instant.parse("2026-09-01T00:00:00Z");

	@Autowired
	MockMvc mvc;
	@Autowired
	ItemRepository items;
	@Autowired
	AnalysisRepository analyses;
	@Autowired
	ItemChangeRepository changes;
	@Autowired
	EntityManager em;
	@Autowired
	EntityManagerFactory emf;
	@Autowired
	TransactionTemplate tx;
	@Autowired
	com.auctionboss.support.MutableClock clock;

	/** 요청 한 번이 준비시킨 SQL 문 수와 응답 행 수. */
	private record Measured(long statements, int rows) {
	}

	/**
	 * 분석, 이력, 관심이 섞인 물건 n건. i%2==0은 분석 2건(v1, v2), i%3==0은 변경 이력 2건(기준점 + 변경),
	 * i%4==0은 관심. 분석 시각은 쿨다운(24시간)보다 오래돼 needsAnalysis 후보가 된다.
	 */
	private List<Item> seed(int n) {
		jdbc.update("DELETE FROM items");
		jdbc.update("DELETE FROM worker_runs");
		jdbc.update("DELETE FROM collector_state");
		List<Item> out = new java.util.ArrayList<>();
		for (int i = 0; i < n; i++) {
			Item it = items.save(item("2026타경" + (i + 1), "1").usageType(i % 2 == 0 ? "아파트" : "다세대주택")
					.schedule(new AuctionSchedule(LocalDate.parse("2026-11-01").plusDays(i), null, null, null, null))
					.build());
			out.add(it);
			if (i % 2 == 0) {
				analyses.save(new Analysis(it, "본문1", "m", "v1", OLD));
				analyses.save(new Analysis(it, "본문2", "m", "v2", OLD.plusSeconds(60)));
			}
			if (i % 3 == 0) {
				changes.save(new ItemChange(it, "status", null, "진행", OLD.minusSeconds(60), ChangeKind.BASELINE));
				changes.save(new ItemChange(it, "minBidPrice", "100", "90", OLD.plusSeconds(120), ChangeKind.CHANGE));
			}
			if (i % 4 == 0) {
				tx.executeWithoutResult(s -> em.persist(new Bookmark(it.getId(), OLD)));
			}
		}
		items.flush();
		// 회차 목록·집계 측정용: 물건 수와 같은 수의 회차(워커와 결과를 섞는다).
		for (int i = 0; i < n; i++) {
			jdbc.update("INSERT INTO worker_runs (worker, started_at, finished_at, outcome, items_changed, created_at) "
					+ "VALUES (?, ?, ?, ?, ?, ?)", i % 2 == 0 ? "collector" : "analyzer",
					java.sql.Timestamp.from(OLD.plusSeconds(i)), java.sql.Timestamp.from(OLD.plusSeconds(i + 1)),
					i % 5 == 0 ? "failed" : "success", i % 2 == 0 ? i : null, java.sql.Timestamp.from(OLD.plusSeconds(i)));
		}
		// 사진 목록·분석 이력 측정용: i%3==0은 사진 2건. 로테이션 위치 기록 1건.
		for (int i = 0; i < n; i += 3) {
			for (int seq = 1; seq <= 2; seq++) {
				jdbc.update("INSERT INTO item_photos (item_id, seq, file_path, file_size, mime_type, collected_at) "
						+ "VALUES (?, ?, ?, 10, 'image/png', ?)", out.get(i).getId(), seq, i + "/" + seq + ".png",
						java.sql.Timestamp.from(OLD));
			}
		}
		jdbc.update("INSERT INTO collector_state (`key`, value, updated_at) VALUES "
				+ "('collector.rotation.nextCourtCode', 'B000211', ?)", java.sql.Timestamp.from(OLD));
		return out;
	}

	private Measured measure(String url) throws Exception {
		Statistics stats = emf.unwrap(SessionFactory.class).getStatistics();
		em.clear();
		stats.clear();
		String body = mvc.perform(get(url)).andReturn().getResponse().getContentAsString();
		long statements = stats.getPrepareStatementCount();
		var node = JSON.readTree(body);
		int rows = node.has("items") ? node.get("items").size()
				: node.has("changes") ? node.get("changes").size()
				: node.has("entries") ? node.get("entries").size()
				: node.has("runs") ? node.get("runs").size()
				: node.has("analyses") ? node.get("analyses").size()
				: node.has("photos") ? node.get("photos").size() : 1;
		return new Measured(statements, rows);
	}

	private void assertConstant(String name, String urlTemplate, long expected, int smallN, int largeN)
			throws Exception {
		List<Item> small = seed(smallN);
		Measured a = measure(url(urlTemplate, small));
		List<Item> large = seed(largeN);
		Measured b = measure(url(urlTemplate, large));
		assertThat(a.statements()).as("%s (물건 %d건, 응답 %d행)", name, smallN, a.rows()).isEqualTo(expected);
		assertThat(b.statements()).as("%s (물건 %d건, 응답 %d행)", name, largeN, b.rows()).isEqualTo(expected);
		assertThat(b.rows()).as("%s: 큰 쪽이 더 많은 행을 돌려줘야 비교가 의미 있다", name).isGreaterThanOrEqualTo(a.rows());
	}

	/** {id}는 시드의 첫 물건(분석, 이력, 관심이 모두 있는 i=0)으로 바꾼다. */
	private static String url(String template, List<Item> seeded) {
		return template.replace("{id}", String.valueOf(seeded.get(0).getId()));
	}

	@Test
	void defaultListIsSelectPlusCount() throws Exception {
		// 목록 SELECT 1(lastChangedAt, bookmarked는 스칼라 서브쿼리) + COUNT 1.
		assertConstant("기본 목록", "/api/items?pageSize=50", 2, 4, 30);
		assertThat(measure("/api/items?pageSize=50").rows()).isEqualTo(30);
	}

	@Test
	void filterAndSortCombinationIsSelectPlusCount() throws Exception {
		assertConstant("필터+정렬", "/api/items?analyzed=false&sort=bidRatio&dir=desc&pageSize=50", 2, 4, 30);
	}

	@Test
	void needsAnalysisWithPromptVersionIsSelectPlusCount() throws Exception {
		assertConstant("needsAnalysis", "/api/items?needsAnalysis=true&promptVersion=v3&pageSize=50", 2, 4, 30);
		// 후보가 실제로 여러 건이어야(분석 있음 i%2==0 -> 15건) 이 측정이 의미 있다.
		assertThat(measure("/api/items?needsAnalysis=true&promptVersion=v3&pageSize=50").rows()).isEqualTo(15);
	}

	@Test
	void detailIsItemPlusLatestAnalysis() throws Exception {
		// 측정값 2: (1) 물건 + lastChangedAt/bookmarked 서브쿼리 컬럼 SELECT 1, (2) 최신 분석 SELECT 1.
		// AnalysisResponse는 item_id를 URL의 id로 채워 지연 프록시를 초기화하지 않는다(추가 쿼리 0).
		assertConstant("상세", "/api/items/{id}", 2, 4, 30);
	}

	@Test
	void changeHistoryIsExistsPlusSelect() throws Exception {
		// 측정값 2: (1) 물건 존재 확인(existsById) 1, (2) 이력 SELECT 1. 이력 행 수와 무관하다.
		assertConstant("변경 이력", "/api/items/{id}/changes", 2, 4, 30);
		assertThat(measure("/api/items/" + seed(30).get(0).getId() + "/changes").rows()).isEqualTo(2);
	}

	@Test
	void bookmarkListIsCountPlusOneJoinedSelect() throws Exception {
		// 측정값 2: (1) 건수 1, (2) bookmarks와 items 조인 + lastChangedAt 서브쿼리 SELECT 1. 담긴 물건 수와 무관하다(N+1 없음).
		assertConstant("관심 목록", "/api/bookmarks?pageSize=50", 2, 4, 30);
		// 담긴 물건은 i%4==0이므로 30건 중 8건이다.
		assertThat(measure("/api/bookmarks?pageSize=50").rows()).isEqualTo(8);
	}

	@Test
	void feedIsCountPlusListPlusUnreadCount() throws Exception {
		// 측정값 3: (1) 피드 건수, (2) 피드 목록, (3) 미확인 개수(마지막 확인 시각은 스칼라 서브쿼리).
		assertConstant("피드", "/api/feed?pageSize=50", 3, 4, 30);
		// 변경 이력이 있는 담긴 물건은 i%12==0이므로 30건 중 3건(각 변경 1건)이다.
		assertThat(measure("/api/feed?pageSize=50").rows()).isEqualTo(3);
		assertConstant("피드(sinceBookmarkedAt)", "/api/feed?pageSize=50&sinceBookmarkedAt=true", 3, 4, 30);
	}

	@Test
	void workerRunListIsCountPlusSelectAndSummaryIsOneStatement() throws Exception {
		assertConstant("회차 목록", "/api/worker-runs?pageSize=50", 2, 4, 30);
		assertThat(measure("/api/worker-runs?pageSize=50").rows()).isEqualTo(30);
		assertConstant("회차 집계", "/api/worker-runs/summary", 1, 4, 30);
	}

	@Test
	void filterOptionsIsFourStatements() throws Exception {
		// 측정값 4: 용도(토큰화 전 값 목록), 시도, 시군구, 법원. 행 수와 무관하다.
		assertConstant("필터 선택지", "/api/items/filter-options", 4, 4, 30);
	}

	@Test
	void analysisHistoryIsExistsPlusListPlusCount() throws Exception {
		// 측정값 3: (1) 물건 존재 확인, (2) 이력 목록(LIMIT), (3) 전체 건수.
		assertConstant("분석 이력", "/api/items/{id}/analyses?limit=11", 3, 4, 30);
		assertConstant("분석 이력(기본)", "/api/items/{id}/analyses", 3, 4, 30);
		assertThat(measure("/api/items/" + seed(30).get(0).getId() + "/analyses?limit=1").rows()).isEqualTo(1);
	}

	@Test
	void photoListIsExistsPlusSelect() throws Exception {
		// 측정값 2: (1) 물건 존재 확인, (2) 사진 목록.
		assertConstant("사진 목록", "/api/items/{id}/photos", 2, 4, 30);
		assertThat(measure("/api/items/" + seed(30).get(0).getId() + "/photos").rows()).isEqualTo(2);
	}

	@Test
	void workerStatusIsLastRunPlusLastSuccessPlusLastCompleted() throws Exception {
		// 측정값 3: (1) 마지막 회차, (2) 마지막 성공, (3) 마지막 완료. 미실행이면 (3)은 건너뛰므로 시계를 회차 직후로 맞춘다.
		clock.set(OLD.plusSeconds(100));
		try {
			assertConstant("워커 상태(collector)", "/api/worker-runs/status?worker=collector", 3, 4, 30);
			assertConstant("워커 상태(analyzer)", "/api/worker-runs/status?worker=analyzer", 3, 4, 30);
		}
		finally {
			clock.set(FixedClockConfig.DEFAULT_NOW);
		}
	}

	@Test
	void rotationIsOneStatement() throws Exception {
		assertConstant("로테이션", "/api/collector-state/rotation", 1, 4, 30);
	}

}
