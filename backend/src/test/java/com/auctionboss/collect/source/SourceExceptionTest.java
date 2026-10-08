package com.auctionboss.collect.source;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.List;

import org.junit.jupiter.api.Test;

/** 2.1: 오류 {@code kind()}가 TS 오류 이름과 같고, 실패 시 요청 수 합산이 {@code attachPagesRequested}와 같다. */
class SourceExceptionTest {

	@Test
	void kindsAreTheTsErrorNames() {
		assertThat(new SourceRequestException("m", "u").kind()).isEqualTo("SourceRequestError");
		assertThat(new ResponseSchemaException("m", List.of()).kind()).isEqualTo("ResponseSchemaError");
		assertThat(new WafBlockedException("m", "p").kind()).isEqualTo("WafBlockedError");
		assertThat(new RobotDetectedException("m", null).kind()).isEqualTo("RobotDetectedError");
	}

	@Test
	void blockedErrorsAreSourceBlockedAndOthersAreNot() {
		assertThat(new WafBlockedException("m", "p")).isInstanceOf(SourceBlockedException.class);
		assertThat(new RobotDetectedException("m", null)).isInstanceOf(SourceBlockedException.class);
		assertThat(new SourceRequestException("m", "u")).isNotInstanceOf(SourceBlockedException.class);
		assertThat(new ResponseSchemaException("m", List.of())).isNotInstanceOf(SourceBlockedException.class);
	}

	@Test
	void requestsMadeIsZeroUntilTheAdapterAttachesIt() {
		assertThat(new SourceRequestException("m", "u").requestsMade()).isZero();
	}

	@Test
	void attachRequestsMadeAddsToWhatAnInnerCallAlreadyFilled() {
		SourceRequestException error = new SourceRequestException("m", "u");

		SourceException.attachRequestsMade(error, 2);
		SourceException.attachRequestsMade(error, 3);

		assertThat(error.requestsMade()).isEqualTo(5);
	}

	@Test
	void attachRequestsMadeReturnsTheSameErrorAndIgnoresOtherThrowables() {
		RobotDetectedException blocked = new RobotDetectedException("m", "안내");
		IllegalStateException other = new IllegalStateException("x");

		assertThat(SourceException.attachRequestsMade(blocked, 1)).isSameAs(blocked);
		assertThat(SourceException.attachRequestsMade(other, 1)).isSameAs(other);
		assertThat(blocked.sourceMessage()).isEqualTo("안내");
	}

	@Test
	void schemaMessageListsIssuesOnFollowingLines() {
		ResponseSchemaException error = new ResponseSchemaException("형식이 다릅니다", List.of("a: x", "b: y"));

		assertThat(error.getMessage()).isEqualTo("형식이 다릅니다\n  - a: x\n  - b: y");
		assertThat(error.issues()).containsExactly("a: x", "b: y");
		assertThat(new ResponseSchemaException("한 줄", List.of()).getMessage()).isEqualTo("한 줄");
	}

}
