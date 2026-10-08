package com.auctionboss.common.body;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.util.List;

import com.auctionboss.common.error.FieldIssue;
import com.auctionboss.common.error.InvalidRequestException;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/** 2.1: zod와 같은 본문 검증 규칙(해석 실패, (root), JS 정수 규칙, 모르는 키 무시, 필드 순서 이슈). */
class BodyValidatorTest {

	private static final JsonMapper JSON = JsonMapper.builder().build();

	private static BodyValidator of(String json) {
		return BodyValidator.of(JsonBody.parse(json.getBytes(java.nio.charset.StandardCharsets.UTF_8)));
	}

	private static JsonNode node(String json) {
		return JSON.readTree(json);
	}

	@Test
	void unparseableBodiesFailWithTheFixedMessageAndNoDetails() {
		for (String raw : new String[] { "", "   ", "not json", "{\"a\":", "{} trailing", "{'a':1}" }) {
			assertThatThrownBy(() -> JsonBody.parse(raw.getBytes())).isInstanceOfSatisfying(InvalidRequestException.class,
					e -> {
						assertThat(e.getMessage()).isEqualTo("JSON 본문을 해석할 수 없습니다");
						assertThat(e.getIssues()).isNull();
					});
		}
		assertThatThrownBy(() -> JsonBody.parse(null)).isInstanceOf(InvalidRequestException.class);
	}

	@Test
	void aNonObjectRootIsReportedAsRootWithTheReceivedType() {
		assertThat(of("[]").issues()).containsExactly(new FieldIssue("(root)", "Expected object, received array"));
		assertThat(of("null").issues()).containsExactly(new FieldIssue("(root)", "Expected object, received null"));
		assertThat(of("\"x\"").issues()).containsExactly(new FieldIssue("(root)", "Expected object, received string"));
		assertThat(of("5").issues()).containsExactly(new FieldIssue("(root)", "Expected object, received number"));
		assertThat(of("true").issues()).containsExactly(new FieldIssue("(root)", "Expected object, received boolean"));
	}

	@Test
	void aStringIsNeverAcceptedAsANumber() {
		BodyValidator v = of("{\"itemId\":\"1\"}");

		assertThat(v.positiveInteger("itemId", "int", "pos")).isNull();
		assertThat(v.issues()).containsExactly(new FieldIssue("itemId", "Expected number, received string"));
	}

	@Test
	void integralValuedFloatsAreIntegersButFractionsAreNot() {
		assertThat(of("{\"n\":1.0}").positiveInteger("n", "int", "pos")).isEqualTo(1.0);
		assertThat(of("{\"n\":2e0}").positiveInteger("n", "int", "pos")).isEqualTo(2.0);

		BodyValidator fraction = of("{\"n\":1.5}");
		assertThat(fraction.positiveInteger("n", "int", "pos")).isNull();
		assertThat(fraction.issues()).containsExactly(new FieldIssue("n", "int"));
	}

	@Test
	void zeroAndNegativesFailThePositiveCheckAndNegativeFractionsFailBoth() {
		BodyValidator zero = of("{\"n\":0}");
		zero.positiveInteger("n", "int", "pos");
		assertThat(zero.issues()).containsExactly(new FieldIssue("n", "pos"));

		BodyValidator both = of("{\"n\":-1.5}");
		both.positiveInteger("n", "int", "pos");
		assertThat(both.issues()).containsExactly(new FieldIssue("n", "int"), new FieldIssue("n", "pos"));
	}

	@Test
	void missingKeysAreRequiredAndNullIsATypeError() {
		BodyValidator v = of("{\"a\":null}");
		v.positiveInteger("missing", "int", "pos");
		v.string("a", true, false, "empty");
		v.string("b", true, false, "empty");

		assertThat(v.issues()).containsExactly(new FieldIssue("missing", "Required"),
				new FieldIssue("a", "Expected string, received null"), new FieldIssue("b", "Required"));
	}

	@Test
	void optionalStringsMayBeAbsentAndNullableOnesMayBeNull() {
		BodyValidator v = of("{\"n\":null}");

		assertThat(v.string("absent", false, false, "empty")).isNull();
		assertThat(v.string("n", false, true, "empty")).isNull();
		assertThat(v.hasIssues()).isFalse();

		v.string("n", false, false, "empty");
		assertThat(v.issues()).containsExactly(new FieldIssue("n", "Expected string, received null"));
	}

	@Test
	void emptyStringsUseTheGivenMessage() {
		BodyValidator v = of("{\"s\":\"\"}");

		assertThat(v.string("s", true, false, "s는 비어 있을 수 없습니다")).isNull();
		assertThat(v.issues()).containsExactly(new FieldIssue("s", "s는 비어 있을 수 없습니다"));
	}

	@Test
	void enumValuesUseZodMessages() {
		List<String> allowed = List.of("a", "b");
		BodyValidator v = of("{\"x\":\"c\",\"y\":1}");
		v.enumValue("x", allowed);
		v.enumValue("y", allowed);
		v.enumValue("z", allowed);

		assertThat(v.issues()).containsExactly(
				new FieldIssue("x", "Invalid enum value. Expected 'a' | 'b', received 'c'"),
				new FieldIssue("y", "Expected 'a' | 'b', received number"), new FieldIssue("z", "Required"));
		assertThat(of("{\"x\":\"b\"}").enumValue("x", allowed)).isEqualTo("b");
	}

	@Test
	void unknownKeysAreIgnoredAndIssuesFollowCallOrder() {
		BodyValidator v = of("{\"extra\":{\"deep\":1},\"b\":\"\",\"a\":5}");

		assertThat(v.string("a", true, false, "empty")).isNull();
		assertThat(v.string("b", true, false, "empty")).isNull();

		assertThat(v.issues()).extracting(FieldIssue::field).containsExactly("a", "b");
		assertThatThrownBy(() -> v.throwIfInvalid("잘못된 본문")).isInstanceOfSatisfying(InvalidRequestException.class,
				e -> {
					assertThat(e.getMessage()).isEqualTo("잘못된 본문");
					assertThat(e.getIssues()).hasSize(2);
				});
	}

	@Test
	void typeNamesFollowZod() {
		assertThat(BodyValidator.typeName(node("[]"))).isEqualTo("array");
		assertThat(BodyValidator.typeName(node("{}"))).isEqualTo("object");
		assertThat(BodyValidator.typeName(node("1.5"))).isEqualTo("number");
		assertThat(BodyValidator.typeName(null)).isEqualTo("undefined");
	}

}
