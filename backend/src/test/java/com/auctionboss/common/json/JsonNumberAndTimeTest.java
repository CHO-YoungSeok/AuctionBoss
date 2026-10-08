package com.auctionboss.common.json;

import static org.assertj.core.api.Assertions.assertThat;

import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;

import com.auctionboss.common.time.ServerClock;
import com.auctionboss.support.MutableClock;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.json.JsonMapper;

/** 2.2: 밀리초로 자른 "지금", JS 숫자 직렬화(정수 값의 실수는 정수로). */
class JsonNumberAndTimeTest {

	private static final JsonMapper MAPPER = JsonMapper.builder().addModule(new JsonConfig().auctionBossJsonModule())
			.build();

	@Test
	void nowIsTruncatedToMillisecondsSoStoredAndRespondedValuesAgree() {
		MutableClock clock = new MutableClock(Instant.parse("2026-10-08T00:00:00.123456789Z"));
		ServerClock serverClock = new ServerClock(clock);

		assertThat(serverClock.now()).isEqualTo(Instant.parse("2026-10-08T00:00:00.123Z"));

		clock.set(Instant.parse("2026-10-08T00:00:00.999999Z"));
		assertThat(serverClock.now()).isEqualTo(Instant.parse("2026-10-08T00:00:00.999Z"));
	}

	@Test
	void integralDoublesAreWrittenAsIntegers() {
		assertThat(MAPPER.writeValueAsString(1.0)).isEqualTo("1");
		assertThat(MAPPER.writeValueAsString(Double.valueOf(3.0))).isEqualTo("3");
		assertThat(MAPPER.writeValueAsString(0.0)).isEqualTo("0");
		assertThat(MAPPER.writeValueAsString(-0.0)).isEqualTo("0");
		assertThat(MAPPER.writeValueAsString(-2.0)).isEqualTo("-2");
		assertThat(MAPPER.writeValueAsString(0.5)).isEqualTo("0.5");
		assertThat(MAPPER.writeValueAsString(2.0 / 3.0)).isEqualTo("0.6666666666666666");
		assertThat(MAPPER.writeValueAsString(1e20)).isEqualTo("100000000000000000000");
	}

	@Test
	void doublesInsideMapsAndRecordsFollowTheSameRule() {
		Map<String, Object> map = new LinkedHashMap<>();
		map.put("a", 3.0);
		map.put("b", 1.5);
		map.put("c", 7);

		assertThat(MAPPER.writeValueAsString(map)).isEqualTo("{\"a\":3,\"b\":1.5,\"c\":7}");
		assertThat(MAPPER.writeValueAsString(new com.auctionboss.worker.RunsSummary(1, 1, 0, 0, 0, 0, 1.0, 0)))
				.contains("\"successRate\":1,");
		assertThat(MAPPER.writeValueAsString(new com.auctionboss.worker.RunsSummary(0, 0, 0, 0, 0, 0, null, 0)))
				.contains("\"successRate\":null");
	}

	@Test
	void jsNumberFormattingMatchesStringOfNumber() {
		assertThat(JsNumbers.format(5)).isEqualTo("5");
		assertThat(JsNumbers.format(1e20)).isEqualTo("100000000000000000000");
		assertThat(JsNumbers.format(1e21)).isEqualTo("1e+21");
		assertThat(JsNumbers.format(0.5)).isEqualTo("0.5");
		assertThat(JsNumbers.format(1.5e-7)).isEqualTo("1.5e-7");
		assertThat(JsNumbers.normalize(3.0)).isEqualTo(3L);
		assertThat(JsNumbers.normalize(3.5)).isEqualTo(3.5);
	}

}
