package com.auctionboss.worker;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.nio.file.Files;
import java.nio.file.Path;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/** 3.1: 워커별 회차 보관 상한은 config/collector.json에서 읽는다. */
class WorkerSettingsTest {

	@TempDir
	Path dir;

	private Path write(String json) throws Exception {
		Path file = dir.resolve("collector.json");
		Files.writeString(file, json);
		return file;
	}

	@Test
	void readsMaxRunsPerWorkerFromTheConfiguredFile() throws Exception {
		Path file = write("{\"observability\":{\"maxRunsPerWorker\":250,\"staleAfterIntervals\":3}}");

		assertThat(new WorkerSettings(file.toString(), null).maxRunsPerWorker()).isEqualTo(250);
	}

	@Test
	void rereadsTheFileOnEveryCall() throws Exception {
		Path file = write("{\"observability\":{\"maxRunsPerWorker\":10}}");
		WorkerSettings settings = new WorkerSettings(file.toString(), null);
		assertThat(settings.maxRunsPerWorker()).isEqualTo(10);

		Files.writeString(file, "{\"observability\":{\"maxRunsPerWorker\":2}}");

		assertThat(settings.maxRunsPerWorker()).isEqualTo(2);
	}

	@Test
	void propertyOverrideWinsAndSkipsTheFile() {
		assertThat(new WorkerSettings("/nonexistent/collector.json", 3).maxRunsPerWorker()).isEqualTo(3);
	}

	@Test
	void defaultPathFindsTheRepositoryConfigFromTheBackendDirectory() {
		assertThat(new WorkerSettings("", null).maxRunsPerWorker()).isGreaterThanOrEqualTo(1);
	}

	@Test
	void rejectsMissingZeroNegativeOrNonIntegerValues() throws Exception {
		for (String json : new String[] { "{\"observability\":{}}", "{\"observability\":{\"maxRunsPerWorker\":0}}",
				"{\"observability\":{\"maxRunsPerWorker\":-5}}", "{\"observability\":{\"maxRunsPerWorker\":1.5}}",
				"{\"observability\":{\"maxRunsPerWorker\":\"10\"}}", "not json" }) {
			Path file = write(json);
			assertThatThrownBy(() -> new WorkerSettings(file.toString(), null).maxRunsPerWorker())
					.as(json).isInstanceOf(IllegalStateException.class);
		}
		assertThatThrownBy(() -> new WorkerSettings("", 0).maxRunsPerWorker())
				.isInstanceOf(IllegalStateException.class);
	}

	@Test
	void missingFileFailsWithAClearMessage() {
		assertThatThrownBy(() -> new WorkerSettings(dir.resolve("none.json").toString(), null).maxRunsPerWorker())
				.isInstanceOf(IllegalStateException.class).hasMessageContaining("none.json");
	}

}
