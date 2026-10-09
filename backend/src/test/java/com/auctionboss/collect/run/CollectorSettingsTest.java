package com.auctionboss.collect.run;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.nio.file.Files;
import java.nio.file.Path;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/** 4.1: 수집 설정 읽기와 TS {@code config.ts} 검증 사례({@code WorkerSettingsTest}와 같은 방식). */
class CollectorSettingsTest {

	private static final String VALID = """
			{"scope":{"courts":[{"name":"서울중앙지방법원","courtCode":"B000210"},{"name":"서울동부지방법원","courtCode":""}],
			          "maxCourtsPerRun":1,"maxRequestsPerRun":13},
			 "intervalMs":600000,
			 "photos":{"intervalMs":1800000,"maxItemsPerRun":5,"requestDelayMs":30000,"retryAfterHours":24}}""";

	@TempDir
	Path dir;

	private Path write(String json) throws Exception {
		Path file = dir.resolve("collector.json");
		Files.writeString(file, json);
		return file;
	}

	private CollectorSettings settings(Path file) {
		return new CollectorSettings(file.toString(), null, null, null, CollectorSettings.DEFAULT_BLOCK_BACKOFF_MS);
	}

	@Test
	void 설정_파일의_범위와_주기와_사진_절을_읽는다() throws Exception {
		CollectorSettings s = settings(write(VALID));

		CollectorSettings.Scope scope = s.scope();
		assertThat(scope.courts()).hasSize(2);
		assertThat(scope.courts().get(0).name()).isEqualTo("서울중앙지방법원");
		assertThat(scope.courts().get(0).courtCode()).isEqualTo("B000210");
		assertThat(scope.courts().get(1).courtCode()).isEmpty();
		assertThat(scope.maxCourtsPerRun()).isEqualTo(1);
		assertThat(scope.maxRequestsPerRun()).isEqualTo(13);
		assertThat(s.intervalMs()).isEqualTo(600_000);
		assertThat(s.photos()).isEqualTo(new CollectorSettings.Photos(1_800_000, 5, 30_000, 24));
		assertThat(s.blockBackoffMs()).isEqualTo(3_600_000);
	}

	@Test
	void 저장소의_실제_설정_파일을_기본_경로로_읽는다() {
		CollectorSettings s = new CollectorSettings("", null, null, null, CollectorSettings.DEFAULT_BLOCK_BACKOFF_MS);

		assertThat(s.scope().courts()).isNotEmpty();
		assertThat(s.scope().maxRequestsPerRun()).isPositive();
		assertThat(s.intervalMs()).isPositive();
		assertThat(s.photos().requestDelayMs()).isPositive();
	}

	@Test
	void 호출마다_파일을_다시_읽어_변경이_다음_회차에_반영된다() throws Exception {
		Path file = write(VALID);
		CollectorSettings s = settings(file);
		assertThat(s.scope().maxRequestsPerRun()).isEqualTo(13);

		Files.writeString(file, VALID.replace("\"maxRequestsPerRun\":13", "\"maxRequestsPerRun\":4"));

		assertThat(s.scope().maxRequestsPerRun()).isEqualTo(4);
	}

	@Test
	void 덮어쓰기_속성이_파일_값보다_우선한다() throws Exception {
		CollectorSettings s = new CollectorSettings(write(VALID).toString(), 3L, 7L, 9L, 1234);

		assertThat(s.scope().maxCourtsPerRun()).isEqualTo(3);
		assertThat(s.scope().maxRequestsPerRun()).isEqualTo(7);
		assertThat(s.photos().maxItemsPerRun()).isEqualTo(9);
		assertThat(s.blockBackoffMs()).isEqualTo(1234);
	}

	@Test
	void 덮어쓰기_속성이_0_이하이면_거절한다() throws Exception {
		String path = write(VALID).toString();

		assertThatThrownBy(() -> new CollectorSettings(path, 0L, null, null, 1)).isInstanceOf(IllegalStateException.class);
		assertThatThrownBy(() -> new CollectorSettings(path, null, -1L, null, 1)).isInstanceOf(IllegalStateException.class);
		assertThatThrownBy(() -> new CollectorSettings(path, null, null, 0L, 1)).isInstanceOf(IllegalStateException.class);
		assertThatThrownBy(() -> new CollectorSettings(path, null, null, null, 0)).isInstanceOf(IllegalStateException.class);
	}

	@Test
	void 법원이_0곳이거나_없으면_거절한다() throws Exception {
		for (String scope : new String[] { "{\"courts\":[],\"maxCourtsPerRun\":1,\"maxRequestsPerRun\":13}",
				"{\"maxCourtsPerRun\":1,\"maxRequestsPerRun\":13}",
				"{\"courts\":\"서울\",\"maxCourtsPerRun\":1,\"maxRequestsPerRun\":13}" }) {
			CollectorSettings s = settings(write("{\"scope\":" + scope + "}"));
			assertThatThrownBy(s::scope).as(scope).isInstanceOf(IllegalStateException.class)
				.hasMessageContaining("scope.courts");
		}
	}

	@Test
	void 법원_이름이_비었거나_코드가_문자열이_아니면_거절한다() throws Exception {
		CollectorSettings emptyName = settings(write(
				"{\"scope\":{\"courts\":[{\"name\":\"\",\"courtCode\":\"B1\"}],\"maxCourtsPerRun\":1,\"maxRequestsPerRun\":1}}"));
		assertThatThrownBy(emptyName::scope).hasMessageContaining("scope.courts.0.name");

		CollectorSettings noCode = settings(write(
				"{\"scope\":{\"courts\":[{\"name\":\"서울\"}],\"maxCourtsPerRun\":1,\"maxRequestsPerRun\":1}}"));
		assertThatThrownBy(noCode::scope).hasMessageContaining("scope.courts.0.courtCode");
	}

	@Test
	void 상한이_없거나_0_이하이거나_정수가_아니거나_문자열이면_필드_이름과_함께_거절한다() throws Exception {
		String courts = "\"courts\":[{\"name\":\"서울중앙지방법원\",\"courtCode\":\"B000210\"}]";
		String[][] cases = { { "{" + courts + ",\"maxRequestsPerRun\":13}", "scope.maxCourtsPerRun" },
				{ "{" + courts + ",\"maxCourtsPerRun\":0,\"maxRequestsPerRun\":13}", "scope.maxCourtsPerRun" },
				{ "{" + courts + ",\"maxCourtsPerRun\":1,\"maxRequestsPerRun\":-1}", "scope.maxRequestsPerRun" },
				{ "{" + courts + ",\"maxCourtsPerRun\":1.5,\"maxRequestsPerRun\":13}", "scope.maxCourtsPerRun" },
				{ "{" + courts + ",\"maxCourtsPerRun\":1,\"maxRequestsPerRun\":\"열세 번\"}", "scope.maxRequestsPerRun" },
				{ "{" + courts + ",\"maxCourtsPerRun\":1,\"maxRequestsPerRun\":null}", "scope.maxRequestsPerRun" } };
		for (String[] c : cases) {
			CollectorSettings s = settings(write("{\"scope\":" + c[0] + "}"));
			assertThatThrownBy(s::scope).as(c[0]).isInstanceOf(IllegalStateException.class).hasMessageContaining(c[1]);
		}
	}

	@Test
	void 정수값인_실수_표기는_정수로_받는다() throws Exception {
		CollectorSettings s = settings(write(VALID.replace("\"maxCourtsPerRun\":1,", "\"maxCourtsPerRun\":2.0,")));

		assertThat(s.scope().maxCourtsPerRun()).isEqualTo(2);
	}

	@Test
	void 주기와_사진_절의_잘못된_값을_거절한다() throws Exception {
		assertThatThrownBy(settings(write("{\"intervalMs\":\"10분\"}"))::intervalMs).hasMessageContaining("intervalMs");
		assertThatThrownBy(settings(write("{\"intervalMs\":0}"))::intervalMs).isInstanceOf(IllegalStateException.class);
		assertThatThrownBy(settings(write("{}"))::photos).hasMessageContaining("photos");
		for (String field : new String[] { "intervalMs", "maxItemsPerRun", "requestDelayMs", "retryAfterHours" }) {
			String bad = VALID.replace("\"" + field + "\":", "\"" + field + "\":0,\"x\":");
			CollectorSettings s = settings(write(bad));
			assertThatThrownBy(s::photos).as(field).hasMessageContaining("photos." + field);
		}
	}

	@Test
	void 파일이_없거나_JSON이_깨졌으면_거절한다() throws Exception {
		assertThatThrownBy(settings(dir.resolve("none.json"))::scope).isInstanceOf(IllegalStateException.class)
			.hasMessageContaining("none.json");
		assertThatThrownBy(settings(write("{ not json"))::scope).isInstanceOf(IllegalStateException.class);
	}

}
