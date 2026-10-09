package com.auctionboss.migration;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.time.LocalDateTime;

import com.auctionboss.support.AbstractMySqlTest;
import com.auctionboss.support.AppLauncher;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.springframework.boot.test.system.CapturedOutput;
import org.springframework.boot.test.system.OutputCaptureExtension;
import org.springframework.context.ConfigurableApplicationContext;

/** 3.5: {@code auctionboss.run-once=export-state}. 롤백 때 되쓸 백오프 종료 시각과 로테이션 위치를 한 줄 JSON으로 낸다(키 없음은 null). */
@ExtendWith(OutputCaptureExtension.class)
class ExportStateIT extends AbstractMySqlTest {

	private AppLauncher.Launched run(String... extra) {
		String[] args = new String[extra.length + 2];
		args[0] = "--auctionboss.run-once=export-state";
		args[1] = "--spring.profiles.active=test";
		System.arraycopy(extra, 0, args, 2, extra.length);
		return AppLauncher.launch(args);
	}

	private void put(String key, String value) {
		jdbc.update("INSERT INTO collector_state (`key`, value, updated_at) VALUES (?, ?, ?)", key, value,
				LocalDateTime.of(2026, 10, 9, 1, 2, 3));
	}

	@Test
	void 키가_없으면_둘_다_null이고_종료_코드_0이다(CapturedOutput output) {
		AppLauncher.Launched launched = run();
		launched.context().close();

		assertThat(launched.exitCode()).isZero();
		assertThat(output.getOut()).contains("{\"backoffUntil\":null,\"rotationNextCourtCode\":null}");
	}

	@Test
	void 백오프와_로테이션이_있으면_밀리초_Z_시각과_법원_코드를_낸다(CapturedOutput output) {
		put("backoff_until", "2026-10-09T05:06:07.400Z");
		put("collector.rotation.nextCourtCode", "B000211");
		AppLauncher.Launched launched = run();
		launched.context().close();

		assertThat(launched.exitCode()).isZero();
		assertThat(output.getOut())
			.contains("{\"backoffUntil\":\"2026-10-09T05:06:07.400Z\",\"rotationNextCourtCode\":\"B000211\"}");
	}

	@Test
	void 초_단위_백오프_값도_밀리초_세_자리로_정규화해_낸다(CapturedOutput output) {
		put("backoff_until", "2026-10-09T05:06:07Z");
		AppLauncher.Launched launched = run();
		launched.context().close();

		assertThat(output.getOut()).contains("{\"backoffUntil\":\"2026-10-09T05:06:07.000Z\",\"rotationNextCourtCode\":null}");
	}

	@Test
	void 읽을_수_없는_백오프_값은_없음으로_본다(CapturedOutput output) {
		put("backoff_until", "not a time");
		AppLauncher.Launched launched = run();
		launched.context().close();

		assertThat(output.getOut()).contains("{\"backoffUntil\":null,\"rotationNextCourtCode\":null}");
	}

	@Test
	void 스케줄러를_켜는_설정과는_함께_쓸_수_없다() {
		assertThatThrownBy(() -> run("--auctionboss.collector.enabled=true", "--auctionboss.config-path=../config/collector.json"))
			.rootCause()
			.hasMessageContaining("스케줄러를 켜는 설정");
	}

	@Test
	void 웹_서버를_띄우지_않는다() {
		AppLauncher.Launched launched = run();
		try (ConfigurableApplicationContext context = launched.context()) {
			assertThat(context).isNotInstanceOf(org.springframework.web.context.WebApplicationContext.class);
		}
	}

}
