package com.auctionboss.migration;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.time.LocalDate;
import java.time.LocalDateTime;
import java.util.Arrays;
import java.util.List;

import org.junit.jupiter.api.Test;

/**
 * 3.1: Java 정규화 규칙 단위 테스트. TS {@code normalize.test.ts}와 같은 사례를 같은 기대 문자열로 둔다(두 구현이 같은 규칙인지의 첫 번째 확인이고,
 * 두 번째는 {@link MigrationGoldenDigestTest}의 골든 해시다). 시각 입력은 MySQL {@code DATETIME(3)}에서 읽은 값(이미 UTC)이다.
 */
class RowNormalizerTest {

	@Test
	void 시각은_밀리초_세_자리_Z_문자열이_된다() {
		assertThat(RowNormalizer.datetime(LocalDateTime.of(2026, 9, 8, 11, 48, 38))).isEqualTo("2026-09-08T11:48:38.000Z");
		assertThat(RowNormalizer.datetime(LocalDateTime.of(2026, 9, 8, 11, 48, 38, 600_000_000)))
			.isEqualTo("2026-09-08T11:48:38.600Z");
		assertThat(RowNormalizer.datetime(LocalDateTime.of(2026, 9, 8, 11, 48, 38, 617_000_000)))
			.isEqualTo("2026-09-08T11:48:38.617Z");
	}

	@Test
	void 키_순서와_공백이_다른_JSON은_같은_문자열이_된다() {
		String a = RowNormalizer.json("{\"b\": 1, \"a\": {\"y\": [3, 2], \"x\": \"z\"}}");
		String b = RowNormalizer.json("{\"a\":{\"x\":\"z\",\"y\":[3,2]},\"b\":1}");
		assertThat(a).isEqualTo("{\"a\":{\"x\":\"z\",\"y\":[3,2]},\"b\":1}");
		assertThat(b).isEqualTo(a);
	}

	@Test
	void JSON_키는_UTF_16_코드_유닛_순으로_정렬한다() {
		// "ｚ"(U+FF5A)와 "😀"(서로게이트 D83D DE00): 코드 유닛 순으로는 😀이 앞이고(UTF-8 바이트 순이라면 ｚ가 앞), TS의 키 정렬과 같다.
		assertThat(RowNormalizer.json("{\"ｚ\":1,\"😀\":2,\"a\":0}")).isEqualTo("{\"a\":0,\"😀\":2,\"ｚ\":1}");
	}

	@Test
	void JSON_안의_문자열은_따옴표_역슬래시_제어_문자만_이스케이프한다() {
		assertThat(RowNormalizer.json("{\"c\": \"한글 😀 \\u0001 \\n \\\\ \\\" \\/ \u007f\"}"))
			.isEqualTo("{\"c\":\"한글 😀 \\u0001 \\n \\\\ \\\" / \u007f\"}");
	}

	@Test
	void JSON_숫자는_정수만_받고_정수값인_실수_표기는_정수로_쓴다() {
		assertThat(RowNormalizer.json("{\"a\": 1.0, \"b\": -0, \"c\": 1e2, \"d\": 9007199254740991, \"e\": [true, null, false]}"))
			.isEqualTo("{\"a\":1,\"b\":0,\"c\":100,\"d\":9007199254740991,\"e\":[true,null,false]}");
	}

	@Test
	void 규칙에_어긋나는_JSON은_값_없는_오류로_거부한다() {
		String sentinel = "__REAL_NAME_SENTINEL__";
		for (String bad : List.of("{\"a\": " + sentinel, "{\"a\": 1.5}", "{\"a\": 12345678901234567}", "{\"a\": 9007199254740992}",
				"{\"a\": 1} " + sentinel, "")) {
			assertThatThrownBy(() -> RowNormalizer.json(bad)).isInstanceOf(IllegalArgumentException.class)
				.hasMessageNotContaining(sentinel);
		}
	}

	@Test
	void 큰_정수는_정확한_10진_문자열이다() {
		assertThat(RowNormalizer.integer(123456789012L)).isEqualTo("123456789012");
		assertThat(RowNormalizer.integer(Long.MAX_VALUE)).isEqualTo("9223372036854775807");
		assertThat(RowNormalizer.integer(-5)).isEqualTo("-5");
	}

	@Test
	void 날짜는_YYYY_MM_DD다() {
		assertThat(RowNormalizer.date(LocalDate.of(2026, 10, 13))).isEqualTo("2026-10-13");
	}

	@Test
	void 빈_문자열은_NULL과_구별되고_제어_문자와_NFD_이모지_뒤쪽_공백이_그대로다() {
		// 행 직렬화에서 제어 문자는 백슬래시-u-00xx(소문자 16진)로, 빈 문자열은 ""로, NULL은 null로 쓴다.
		assertThat(RowNormalizer.line(Arrays.asList("", null, "\u0001\u001fᄀ"))).isEqualTo("[\"\",null,\"\\u0001\\u001fᄀ\"]");
		assertThat(RowNormalizer.line(Arrays.asList("끝 공백  ", "😀 a\\b\n", "\u0001a\tb가")))
			.isEqualTo("[\"끝 공백  \",\"😀 a\\\\b\\n\",\"\\u0001a\\tb가\"]");
	}

	@Test
	void 행_직렬화는_공백_없는_JSON_배열이다() {
		assertThat(RowNormalizer.line(List.of("a", "v", "2026-09-08T11:48:38.617Z"))).isEqualTo("[\"a\",\"v\",\"2026-09-08T11:48:38.617Z\"]");
	}

	@Test
	void 문자열은_NFC로_정규화하지_않고_trim하지_않는다() {
		String nfd = "가 ";
		assertThat(RowNormalizer.line(List.of(nfd))).isEqualTo("[\"" + nfd + "\"]");
	}

	@Test
	void 컬럼_종류는_MySQL_형식에서_정한다() {
		assertThat(TableDigest.kindOf("bigint")).isEqualTo(RowNormalizer.Kind.INT);
		assertThat(TableDigest.kindOf("int")).isEqualTo(RowNormalizer.Kind.INT);
		assertThat(TableDigest.kindOf("datetime")).isEqualTo(RowNormalizer.Kind.DATETIME);
		assertThat(TableDigest.kindOf("date")).isEqualTo(RowNormalizer.Kind.DATE);
		assertThat(TableDigest.kindOf("json")).isEqualTo(RowNormalizer.Kind.JSON);
		assertThat(TableDigest.kindOf("varchar")).isEqualTo(RowNormalizer.Kind.TEXT);
		assertThat(TableDigest.kindOf("mediumtext")).isEqualTo(RowNormalizer.Kind.TEXT);
	}

}
