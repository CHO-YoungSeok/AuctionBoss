package com.auctionboss.migration;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.time.Instant;
import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.List;

import com.auctionboss.collect.collector.RotationStore;
import com.auctionboss.collect.run.BackoffStore;
import com.auctionboss.collect.run.WorkerScheduler;
import com.auctionboss.support.AppLauncher;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.system.CapturedOutput;
import org.springframework.boot.test.system.OutputCaptureExtension;
import org.springframework.context.ConfigurableApplicationContext;

/**
 * 3.4: 이전 완료 표식과 기동 조건(D7). {@code prod} 프로필에서 수집·사진 스케줄러가 켜져 있는데 표식이 없으면 기동을 거부한다. {@code local}·{@code test}
 * 프로필과 스케줄러가 꺼진 실행은 표식 없이도 뜬다. 띄운 컨텍스트는 실제 애플리케이션 기동 경로로 만들고(웹 서버는 임의 포트) 소스 주소는 닫힌
 * 루프백 포트라 어떤 외부 요청도 나갈 수 없다.
 */
@ExtendWith(OutputCaptureExtension.class)
class MigrationGuardIT extends AbstractImportTest {

	private static final String NO_MARKER = "이전 완료 표식";

	@Autowired
	BackoffStore backoff;

	@Autowired
	RotationStore rotation;

	/** 스케줄러를 켠 실행의 공통 인자. 첫 틱은 기동 직후가 아니고(run-immediately=false) 주기도 길어 회차가 돌지 않는다. */
	private static List<String> schedulerArgs(String profile, String... enabled) {
		List<String> args = new ArrayList<>(List.of("--spring.profiles.active=" + profile, "--server.port=0",
				"--auctionboss.config-path=../config/collector.json", "--auctionboss.collector.run-immediately=false",
				"--auctionboss.photos.run-immediately=false", "--auctionboss.photos.dir=" + photosDir(),
				"--auctionboss.source.base-url=http://127.0.0.1:9"));
		for (String flag : enabled) {
			args.add("--auctionboss." + flag + ".enabled=true");
		}
		return args;
	}

	private static ConfigurableApplicationContext start(List<String> args) {
		return AppLauncher.start(args.toArray(String[]::new));
	}

	private void insertMarker() {
		jdbc.update("INSERT INTO collector_state (`key`, value, updated_at) VALUES (?, '{}', ?)", MigrationMarker.KEY,
				LocalDateTime.of(2026, 10, 9, 1, 2, 3));
	}

	@Test
	void prod_프로필에_수집을_켜고_표식이_없으면_컨텍스트_시작이_실패하고_로그에_이유가_남고_요청은_없다(CapturedOutput output) {
		assertThatThrownBy(() -> start(schedulerArgs("prod", "collector"))).isInstanceOf(IllegalStateException.class)
			.hasMessageContaining(NO_MARKER);

		assertThat(output.getAll()).contains(NO_MARKER, "런북");
		assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM worker_runs", Integer.class)).as("회차가 하나도 없다").isZero();
	}

	@Test
	void prod_프로필에_사진만_켜도_표식이_없으면_기동을_거부한다() {
		assertThatThrownBy(() -> start(schedulerArgs("prod", "photos"))).hasMessageContaining(NO_MARKER);
	}

	@Test
	void prod_프로필에_표식이_있으면_기동하고_스케줄러_빈이_있다() {
		insertMarker();
		try (ConfigurableApplicationContext context = start(schedulerArgs("prod", "collector", "photos"))) {
			assertThat(context.getBeansOfType(WorkerScheduler.class)).hasSize(1);
			assertThat(context.getBeansOfType(MigrationGuard.class)).hasSize(1);
		}
	}

	@Test
	void prod_프로필이어도_스케줄러가_꺼져_있으면_검사하지_않고_뜬다() {
		try (ConfigurableApplicationContext context = start(schedulerArgs("prod"))) {
			assertThat(context.getBeansOfType(WorkerScheduler.class)).isEmpty();
			assertThat(context.getBeansOfType(MigrationGuard.class)).isEmpty();
		}
	}

	@Test
	void local_프로필은_표식_없이도_스케줄러를_켜고_기동한다() {
		try (ConfigurableApplicationContext context = start(schedulerArgs("local", "collector", "photos"))) {
			assertThat(context.getBeansOfType(WorkerScheduler.class)).hasSize(1);
			assertThat(context.getBeansOfType(MigrationGuard.class)).isEmpty();
		}
	}

	@Test
	void test_프로필도_표식_없이_스케줄러를_켜고_기동한다() {
		try (ConfigurableApplicationContext context = start(schedulerArgs("test", "collector"))) {
			assertThat(context.getBeansOfType(WorkerScheduler.class)).hasSize(1);
			assertThat(context.getBeansOfType(MigrationGuard.class)).isEmpty();
		}
	}

	@Test
	void 표식_키는_로테이션_조회_API와_백오프_판정에_영향이_없다() throws Exception {
		insertMarker();

		assertThat(backoff.until()).isEmpty();
		assertThat(backoff.remainingMs(Instant.parse("2026-10-09T02:00:00Z"))).isZero();
		assertThat(rotation.get()).isNull();
		mvc.perform(get("/api/collector-state/rotation")).andExpect(status().isOk())
			.andExpect(content().json("{\"nextCourtCode\":null}"));
	}

	@Test
	void 해시_대조는_표식_키를_뺀다() throws Exception {
		MigrationManifest manifest = GoldenFixture.manifest();
		try (Connection connection = dataSource.getConnection()) {
			GoldenFixture.loadSql(connection, manifest);
		}
		insertMarker();

		MigrationManifest.Table expected = manifest.tables().get("collector_state");
		try (Connection connection = dataSource.getConnection()) {
			assertThat(TableDigest.compute(connection, "collector_state", expected.columns()))
				.isEqualTo(new TableDigest.Result(expected.rows(), expected.sha256()));
		}
	}

	@Test
	void 가져오기_모드의_일회_실행은_prod_프로필에서도_표식_검사_없이_뜬다() throws Exception {
		// 가져오기는 표식을 만드는 쪽이다: 스케줄러가 꺼져 있고(일회 실행은 켜는 설정과 함께 쓸 수 없다) 검사 빈이 없어야 한다.
		List<String> args = schedulerArgs("prod");
		args.add("--auctionboss.run-once=import");
		args.add("--auctionboss.import.dir=" + GoldenFixture.DIR);
		AppLauncher.Launched launched = AppLauncher.launch(args.toArray(String[]::new));
		launched.context().close();

		assertThat(launched.exitCode()).isZero();
		assertThat(markerExists()).isTrue();
		assertThat(Files.exists(Path.of("src/test/resources/migration"))).isTrue();
	}

	@Test
	void 일회_실행_모드는_스케줄러를_켜는_설정과_함께_쓸_수_없다() {
		List<String> args = schedulerArgs("test", "collector");
		args.add("--auctionboss.run-once=import");
		args.add("--auctionboss.import.dir=" + GoldenFixture.DIR);

		assertThatThrownBy(() -> start(args)).rootCause().hasMessageContaining("스케줄러를 켜는 설정");
		assertThat(markerExists()).isFalse();
	}

	@Test
	void 알_수_없는_일회_실행_값은_기존처럼_기동_실패다() {
		List<String> args = schedulerArgs("test");
		args.add("--auctionboss.run-once=nope");

		assertThatThrownBy(() -> start(args)).rootCause().hasMessageContaining("collector 또는 photos여야 합니다");
	}

}
