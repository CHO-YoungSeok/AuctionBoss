package com.auctionboss.collect.runonce;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.Map;

import com.auctionboss.BackendApplication;
import com.auctionboss.collect.run.RunLock;
import com.auctionboss.collect.source.ReplayServer;
import com.auctionboss.collect.source.ReplayServer.Reply;
import com.auctionboss.support.AbstractMySqlTest;
import com.auctionboss.support.MySqlTestContainer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.ApplicationContext;
import org.springframework.context.ConfigurableApplicationContext;
import org.springframework.core.type.classreading.MetadataReader;
import org.springframework.core.type.classreading.MetadataReaderFactory;
import org.springframework.boot.context.TypeExcludeFilter;
import org.springframework.web.context.WebApplicationContext;

/**
 * 8.2: 1회 실행 모드. 실제 애플리케이션 기동 경로({@link SpringApplication}, 웹 서버 없음)로 수집·사진을 각각 한 번 실행하고, 루프백 가짜
 * 서버(MockWebServer)가 받은 요청이 각각 2개(세션 1 + 검색 또는 상세 1)인지 확인한다. 외부 사이트에는 요청하지 않는다: 소스 주소는
 * 가짜 서버이거나(요청 수 확인), 외부 요청 허용이 꺼진 상태의 문서화용 대역 주소(소켓을 열기 전에 거절)다.
 *
 * <p>
 * 공용 MySQL 컨테이너를 쓰고(컨텍스트를 새로 띄우지만 닫아도 컨테이너는 남는다) {@code @DirtiesContext}는 쓰지 않는다.
 */
class RunOnceTest extends AbstractMySqlTest {

	private static final String GIF = "R0lGODlhAQABAAAAACw=";

	private static final String CONFIG = "src/test/resources/config/collector-fast.json";

	private static final Path PHOTOS_DIR = createDirectory();

	private static Path createDirectory() {
		try {
			return Files.createTempDirectory("auctionboss-run-once-");
		}
		catch (IOException e) {
			throw new UncheckedIOException(e);
		}
	}

	@Autowired
	ApplicationContext testContext;

	@Autowired
	RunLock runLock;

	@BeforeEach
	void cleanPhotos() {
		jdbc.update("DELETE FROM item_photos");
		deleteChildren();
	}

	@AfterEach
	void cleanPhotosAfter() {
		deleteChildren();
	}

	private static void deleteChildren() {
		try (var walk = Files.walk(PHOTOS_DIR)) {
			walk.sorted(java.util.Comparator.reverseOrder()).filter(p -> !p.equals(PHOTOS_DIR)).forEach(p -> {
				try {
					Files.delete(p);
				}
				catch (IOException e) {
					throw new UncheckedIOException(e);
				}
			});
		}
		catch (IOException e) {
			throw new UncheckedIOException(e);
		}
	}

	private static Reply session() {
		return new Reply(200, List.of("JSESSIONID=s1; Path=/"), "<html/>", false);
	}

	private static Reply search() {
		return Reply.ok("{\"data\":{\"ipcheck\":true,\"dma_pageInfo\":{\"totalCnt\":\"1\"},\"dlt_srchResult\":[{"
				+ "\"boCd\":\"B000210\",\"saNo\":\"20260130000001\",\"maemulSer\":\"1\",\"srnSaNo\":\"2026타경1\","
				+ "\"jiwonNm\":\"서울중앙지방법원\",\"dspslUsgNm\":\"아파트\",\"gamevalAmt\":\"500000000\","
				+ "\"minmaePrice\":\"400000000\",\"maeGiil\":\"20261101\",\"yuchalCnt\":\"0\",\"addrGbncd\":\"A\","
				+ "\"printSt\":\"서울특별시 어딘가 1\"}]}}");
	}

	private static Reply detail() {
		return Reply.ok("{\"data\":{\"ipcheck\":true,\"dma_result\":{\"csBaseInfo\":{},\"csPicLst\":["
				+ "{\"cortAuctnPicSeq\":\"1\",\"picFile\":\"" + GIF + "\"}]}}}");
	}

	/** 이 애플리케이션을 그대로 한 번 기동한다. 웹 서버 없이 회차 하나를 돌고 종료 코드를 돌려준다. 컨텍스트를 호출자에게 넘긴다. */
	private record Launched(ConfigurableApplicationContext context, int exitCode) {
	}

	private Launched launch(String... extraArgs) {
		SpringApplication app = new SpringApplication(BackendApplication.class);
		// 같은 클래스 경로의 테스트 전용 설정(@TestConfiguration: 가짜 소스 등)이 컴포넌트 스캔에 딸려 오지 않게 한다.
		app.addInitializers(ctx -> ctx.getBeanFactory().registerSingleton("testConfigurationExcluder", new TestConfigurationExcluder()));
		List<String> args = new ArrayList<>(List.of(extraArgs));
		args.add("--spring.datasource.url=" + MySqlTestContainer.MYSQL.getJdbcUrl());
		args.add("--spring.datasource.username=" + MySqlTestContainer.MYSQL.getUsername());
		args.add("--spring.datasource.password=" + MySqlTestContainer.MYSQL.getPassword());
		args.add("--spring.datasource.hikari.maximum-pool-size=3");
		args.add("--auctionboss.config-path=" + CONFIG);
		args.add("--auctionboss.photos.dir=" + PHOTOS_DIR);
		args.add("--auctionboss.source.page-delay-ms=1");
		ConfigurableApplicationContext context = app.run(args.toArray(String[]::new));
		return new Launched(context, SpringApplication.exit(context));
	}

	/** {@link org.springframework.boot.test.context.TestConfiguration}이 붙은 클래스(와 그 안쪽 클래스)를 스캔에서 뺀다. */
	static final class TestConfigurationExcluder extends TypeExcludeFilter {

		@Override
		public boolean match(MetadataReader reader, MetadataReaderFactory factory) {
			return reader.getAnnotationMetadata().isAnnotated(TestConfiguration.class.getName());
		}

		@Override
		public boolean equals(Object o) {
			return o instanceof TestConfigurationExcluder;
		}

		@Override
		public int hashCode() {
			return TestConfigurationExcluder.class.hashCode();
		}

	}

	private long pendingItem(String caseNo) {
		jdbc.update("""
				INSERT INTO items (court, case_no, item_no, first_seen_at, last_seen_at, internal_case_no, court_code)
				VALUES ('서울중앙지방법원', ?, '1', ?, ?, '20260130000001', 'B000210')""", caseNo,
				Timestamp.from(Instant.parse("2026-10-01T00:00:00Z")), Timestamp.from(Instant.parse("2026-10-01T00:00:00Z")));
		return jdbc.queryForObject("SELECT id FROM items WHERE case_no = ?", Long.class, caseNo);
	}

	@Test
	void 수집_1회는_웹_서버_없이_요청_2개로_끝나고_종료_코드_0이다() throws Exception {
		try (ReplayServer server = new ReplayServer(List.of(session(), search()))) {
			Launched launched = launch("--auctionboss.run-once=collector", "--auctionboss.source.base-url=" + server.baseUrl(),
					"--auctionboss.source.max-pages=1", "--auctionboss.collector.max-courts-per-run=1");

			assertThat(launched.exitCode()).isZero();
			assertThat(launched.context()).as("웹 서버를 띄우지 않는다").isNotInstanceOf(WebApplicationContext.class);
			assertThat(server.requests()).as("세션 1 + 검색 1").extracting(ReplayServer.Recorded::path)
				.containsExactly("/pgj/index.on", "/pgj/pgjsearch/searchControllerMain.on");
			assertThat(jdbc.queryForList("SELECT worker, outcome FROM worker_runs")).containsExactly(
					Map.of("worker", "collector", "outcome", "success"));
			assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM items", Integer.class)).isEqualTo(1);
		}
	}

	@Test
	void 사진_1회는_지정한_물건_하나만_요청_2개로_저장하고_종료_코드_0이다() throws Exception {
		long target = pendingItem("2026타경1");
		pendingItem("2026타경2"); // 대기 중이지만 지정하지 않았으므로 요청하지 않는다
		try (ReplayServer server = new ReplayServer(List.of(session(), detail()))) {
			Launched launched = launch("--auctionboss.run-once=photos", "--auctionboss.source.base-url=" + server.baseUrl(),
					"--auctionboss.photos.only-item-id=" + target, "--auctionboss.photos.max-items-per-run=5");

			assertThat(launched.exitCode()).isZero();
			assertThat(launched.context()).isNotInstanceOf(WebApplicationContext.class);
			assertThat(server.requests()).as("세션 1 + 상세 1").extracting(ReplayServer.Recorded::path)
				.containsExactly("/pgj/index.on", "/pgj/pgj15B/selectAuctnCsSrchRslt.on");
			assertThat(jdbc.queryForList("SELECT worker, outcome FROM worker_runs")).containsExactly(
					Map.of("worker", "photos", "outcome", "success"));
			assertThat(jdbc.queryForObject("SELECT photo_status FROM items WHERE id = ?", String.class, target))
				.isEqualTo("collected");
			assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM items WHERE photo_status IS NOT NULL", Integer.class))
				.isEqualTo(1);
			assertThat(Files.readAllBytes(PHOTOS_DIR.resolve(target + "/1.gif"))).isEqualTo(Base64.getDecoder().decode(GIF));
		}
	}

	@Test
	void 외부_요청_허용_없이_실제_주소를_가리키면_소켓을_열기_전에_거절되어_종료_코드_1이다() {
		// 문서화용 대역(TEST-NET-3)의 숫자 주소: 허용이 꺼져 있으면 어댑터가 요청 전에 거절한다.
		Launched launched = launch("--auctionboss.run-once=collector", "--auctionboss.source.base-url=http://203.0.113.10",
				"--auctionboss.source.external-requests-allowed=false");

		assertThat(launched.exitCode()).isEqualTo(1);
		assertThat(jdbc.queryForMap("SELECT outcome, error_kind FROM worker_runs WHERE worker = 'collector'"))
			.containsEntry("outcome", "failed")
			.containsEntry("error_kind", "SourceRequestError");
		assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM collector_state WHERE `key` = 'backoff_until'", Integer.class))
			.isZero();
	}

	@Test
	void 공유_백오프가_남았으면_요청_없이_backoff_건너뜀으로_기록하고_종료_코드_1이다() throws Exception {
		jdbc.update("INSERT INTO collector_state (`key`, value, updated_at) VALUES ('backoff_until', ?, ?)",
				Instant.now().plusSeconds(3600).toString(), Timestamp.from(Instant.now()));
		try (ReplayServer server = new ReplayServer(List.of(session(), search()))) {
			Launched launched = launch("--auctionboss.run-once=collector", "--auctionboss.source.base-url=" + server.baseUrl());

			assertThat(launched.exitCode()).isEqualTo(1);
			assertThat(server.requests()).isEmpty();
			assertThat(jdbc.queryForMap("SELECT outcome, error_kind FROM worker_runs WHERE worker = 'collector'"))
				.containsEntry("outcome", "skipped")
				.containsEntry("error_kind", "backoff");
		}
	}

	@Test
	void 같은_워커가_이미_실행_중이면_overlap_건너뜀으로_기록하고_종료_코드_1이다() throws Exception {
		try (RunLock.Held held = runLock.tryAcquire("auctionboss.collector").orElseThrow();
				ReplayServer server = new ReplayServer(List.of(session(), search()))) {
			Launched launched = launch("--auctionboss.run-once=collector", "--auctionboss.source.base-url=" + server.baseUrl());

			assertThat(launched.exitCode()).isEqualTo(1);
			assertThat(server.requests()).isEmpty();
			assertThat(jdbc.queryForMap("SELECT outcome, error_kind FROM worker_runs WHERE worker = 'collector'"))
				.containsEntry("outcome", "skipped")
				.containsEntry("error_kind", "overlap");
			assertThat(held).isNotNull();
		}
	}

	@Test
	void 잘못된_모드나_스케줄러_설정과의_동시_지정은_요청_전에_기동이_실패한다() throws Exception {
		try (ReplayServer server = new ReplayServer(List.of(session(), search()))) {
			String base = "--auctionboss.source.base-url=" + server.baseUrl();
			assertThatThrownBy(() -> launch("--auctionboss.run-once=analysis", base)).hasStackTraceContaining("collector 또는 photos");
			assertThatThrownBy(() -> launch("--auctionboss.run-once=collector", "--auctionboss.collector.enabled=true", base))
				.hasStackTraceContaining("함께 쓸 수 없습니다");
			assertThat(server.requests()).isEmpty();
		}
	}

	@Test
	void 속성이_없으면_1회_실행_빈이_없다() {
		assertThat(testContext.getBeansOfType(RunOnceRunner.class)).isEmpty();
	}

	@Test
	void 시작_진입점은_1회_실행이면_종료_코드를_돌려준다() throws Exception {
		try (ReplayServer server = new ReplayServer(List.of(session(), search()))) {
			Integer code = BackendApplication.start("--auctionboss.run-once=collector",
					"--auctionboss.source.base-url=" + server.baseUrl(), "--auctionboss.source.max-pages=1",
					"--auctionboss.source.page-delay-ms=1", "--auctionboss.config-path=" + CONFIG,
					"--spring.datasource.url=" + MySqlTestContainer.MYSQL.getJdbcUrl(),
					"--spring.datasource.username=" + MySqlTestContainer.MYSQL.getUsername(),
					"--spring.datasource.password=" + MySqlTestContainer.MYSQL.getPassword(),
					"--spring.datasource.hikari.maximum-pool-size=3");
			assertThat(code).isZero();
			assertThat(server.requests()).hasSize(2);
		}
	}

}
