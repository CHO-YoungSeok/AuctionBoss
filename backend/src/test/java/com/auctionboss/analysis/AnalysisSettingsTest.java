package com.auctionboss.analysis;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.nio.file.Files;
import java.nio.file.Path;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/** 5.4: 재분석 최소 간격은 config/collector.json에서 읽는다(요청 파라미터가 아니다). */
class AnalysisSettingsTest {

	@TempDir
	Path dir;

	private Path write(String json) throws Exception {
		Path file = dir.resolve("collector.json");
		Files.writeString(file, json);
		return file;
	}

	@Test
	void readsCooldownHoursFromTheConfiguredFile() throws Exception {
		Path file = write("{\"analysis\":{\"maxItemsPerRun\":5,\"reanalysisCooldownHours\":36}}");

		assertThat(new AnalysisSettings(file.toString(), null).reanalysisCooldownHours()).isEqualTo(36);
	}

	@Test
	void rereadsTheFileOnEveryCallSoEditsApplyWithoutRestart() throws Exception {
		Path file = write("{\"analysis\":{\"reanalysisCooldownHours\":24}}");
		AnalysisSettings settings = new AnalysisSettings(file.toString(), null);
		assertThat(settings.reanalysisCooldownHours()).isEqualTo(24);

		Files.writeString(file, "{\"analysis\":{\"reanalysisCooldownHours\":1}}");

		assertThat(settings.reanalysisCooldownHours()).isEqualTo(1);
	}

	@Test
	void propertyOverrideWinsAndSkipsTheFile() {
		assertThat(new AnalysisSettings("/nonexistent/collector.json", 6).reanalysisCooldownHours()).isEqualTo(6);
		assertThat(AnalysisSettings.ofCooldownHours(0).reanalysisCooldownHours()).isZero();
	}

	@Test
	void defaultPathFindsTheRepositoryConfigFromTheBackendDirectory() {
		// Gradle 테스트의 작업 디렉터리는 backend/ 이므로 ../config/collector.json이 잡힌다.
		assertThat(new AnalysisSettings("", null).reanalysisCooldownHours()).isGreaterThanOrEqualTo(0);
	}

	@Test
	void rejectsMissingNegativeOrNonIntegerValues() throws Exception {
		assertThatThrownBy(() -> new AnalysisSettings(write("{\"analysis\":{}}").toString(), null)
				.reanalysisCooldownHours()).isInstanceOf(IllegalStateException.class);
		assertThatThrownBy(() -> new AnalysisSettings(write("{\"analysis\":{\"reanalysisCooldownHours\":-1}}").toString(),
				null).reanalysisCooldownHours()).isInstanceOf(IllegalStateException.class);
		assertThatThrownBy(() -> new AnalysisSettings(write("{\"analysis\":{\"reanalysisCooldownHours\":1.5}}").toString(),
				null).reanalysisCooldownHours()).isInstanceOf(IllegalStateException.class);
		assertThatThrownBy(() -> new AnalysisSettings(write("not json").toString(), null).reanalysisCooldownHours())
				.isInstanceOf(IllegalStateException.class);
	}

	@Test
	void missingFileFailsWithAClearMessage() {
		assertThatThrownBy(() -> new AnalysisSettings(dir.resolve("none.json").toString(), null)
				.reanalysisCooldownHours()).isInstanceOf(IllegalStateException.class)
						.hasMessageContaining("none.json");
	}

}
