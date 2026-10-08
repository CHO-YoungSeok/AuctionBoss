package com.auctionboss.worker;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import com.auctionboss.common.error.FieldIssue;
import com.auctionboss.common.error.InvalidRequestException;
import org.junit.jupiter.api.Test;

/**
 * 3.2: 원본 {@code worker-run-query.ts}와 그 라우트 테스트의 거절·허용 사례. zod의 이슈 순서와 필드 이름을 그대로 확인한다.
 */
class WorkerRunQueryParserTest {

	private static Map<String, List<String>> q(String... kv) {
		Map<String, List<String>> m = new LinkedHashMap<>();
		for (int i = 0; i < kv.length; i += 2) {
			m.computeIfAbsent(kv[i], k -> new java.util.ArrayList<>()).add(kv[i + 1]);
		}
		return m;
	}

	private static List<String> fields(Map<String, List<String>> params, boolean summary) {
		InvalidRequestException e = org.junit.jupiter.api.Assertions.assertThrows(InvalidRequestException.class,
				() -> {
					if (summary) {
						WorkerRunQueryParser.parseSummary(params);
					}
					else {
						WorkerRunQueryParser.parseList(params);
					}
				});
		assertThat(e.getMessage()).isEqualTo("잘못된 요청 파라미터입니다");
		return e.getIssues().stream().map(FieldIssue::field).toList();
	}

	@Test
	void emptyQueryUsesDefaults() {
		WorkerRunQueryParser.ListQuery query = WorkerRunQueryParser.parseList(q());

		assertThat(query.worker()).isNull();
		assertThat(query.outcome()).isNull();
		assertThat(query.page().page()).isEqualTo(1);
		assertThat(query.page().pageSize()).isEqualTo(20);
	}

	@Test
	void acceptsEveryRecognizedValue() {
		WorkerRunQueryParser.ListQuery query = WorkerRunQueryParser
				.parseList(q("worker", "analyzer", "outcome", "blocked", "page", "3", "pageSize", "200"));

		assertThat(query.worker()).isEqualTo("analyzer");
		assertThat(query.outcome()).isEqualTo(RunOutcome.BLOCKED);
		assertThat(query.page().page()).isEqualTo(3);
		assertThat(query.page().pageSize()).isEqualTo(200);
		for (String outcome : List.of("running", "success", "failed", "blocked", "skipped")) {
			assertThat(WorkerRunQueryParser.parseList(q("outcome", outcome)).outcome().dbValue()).isEqualTo(outcome);
		}
		for (String worker : List.of("collector", "analyzer", "photos")) {
			assertThat(WorkerRunQueryParser.parseList(q("worker", worker)).worker()).isEqualTo(worker);
		}
	}

	@Test
	void unknownWorkerAndOutcomeAreRejectedWithTheirOwnField() {
		assertThat(fields(q("worker", "nope"), false)).containsExactly("worker");
		assertThat(fields(q("outcome", "nope"), false)).containsExactly("outcome");
		assertThat(fields(q("worker", "nope", "outcome", "nope"), false)).containsExactly("worker", "outcome");
	}

	@Test
	void recognizedParametersWithEmptyValuesAreIssues() {
		assertThat(fields(q("worker", ""), false)).containsExactly("worker");
		assertThat(fields(q("outcome", "  "), false)).containsExactly("outcome");
		assertThat(fields(q("page", ""), false)).containsExactly("page");
		assertThat(fields(q("pageSize", ""), false)).containsExactly("pageSize");
		assertThat(fields(q("since", ""), true)).containsExactly("since");
	}

	@Test
	void pageRulesFollowTheZodChain() {
		assertThat(fields(q("page", "0"), false)).containsExactly("page");
		assertThat(fields(q("page", "-1"), false)).containsExactly("page");
		assertThat(fields(q("page", "1.5"), false)).containsExactly("page");
		assertThat(fields(q("page", "abc"), false)).containsExactly("page");
		assertThat(fields(q("pageSize", "0"), false)).containsExactly("pageSize");
		assertThat(fields(q("pageSize", "201"), false)).containsExactly("pageSize");
		assertThat(fields(q("pageSize", "1000"), false)).containsExactly("pageSize");
		// 안전 정수를 넘으면 "너무 큽니다"와 상한 초과가 둘 다 나온다(원본 zod와 같다). page는 하한만 있어 하나다.
		assertThat(fields(q("pageSize", "99999999999999999999"), false)).containsExactly("pageSize", "pageSize");
		assertThat(fields(q("page", "99999999999999999999"), false)).containsExactly("page");
	}

	@Test
	void messagesUseTheOriginalWording() {
		InvalidRequestException e = org.junit.jupiter.api.Assertions.assertThrows(InvalidRequestException.class,
				() -> WorkerRunQueryParser.parseList(q("worker", "x", "page", "0", "pageSize", "201")));

		assertThat(e.getIssues()).containsExactly(new FieldIssue("worker", "worker는 collector, analyzer, photos 중 하나여야 합니다"),
				new FieldIssue("page", "page는 1 이상이어야 합니다"), new FieldIssue("pageSize", "pageSize는 200 이하여야 합니다"));
	}

	@Test
	void firstValueWinsForRepeatedParametersAndValuesAreTrimmed() {
		WorkerRunQueryParser.ListQuery query = WorkerRunQueryParser.parseList(q("worker", " analyzer ", "worker", "nope"));

		assertThat(query.worker()).isEqualTo("analyzer");
	}

	@Test
	void unknownParametersAreIgnored() {
		assertThat(WorkerRunQueryParser.parseList(q("foo", "bar")).worker()).isNull();
		assertThat(WorkerRunQueryParser.parseSummary(q("page", "abc")).since()).isNull();
	}

	@Test
	void summaryAcceptsDateOnlyZuluAndOffsetSince() {
		assertThat(WorkerRunQueryParser.parseSummary(q("since", "2026-10-01")).since())
				.isEqualTo(Instant.parse("2026-10-01T00:00:00Z"));
		assertThat(WorkerRunQueryParser.parseSummary(q("since", "2026-10-01T05:06:07.890Z")).since())
				.isEqualTo(Instant.parse("2026-10-01T05:06:07.890Z"));
		assertThat(WorkerRunQueryParser.parseSummary(q("since", "2026-10-01T09:00:00+09:00")).since())
				.isEqualTo(Instant.parse("2026-10-01T00:00:00Z"));
		assertThat(WorkerRunQueryParser.parseSummary(q("worker", "photos", "since", "2025-01-01T00:00:00.000Z")).worker())
				.isEqualTo("photos");
	}

	@Test
	void summaryRejectsNonDatesAndFormatsOnlyJsAccepts() {
		assertThat(fields(q("since", "abc"), true)).containsExactly("since");
		assertThat(fields(q("since", "not-a-date"), true)).containsExactly("since");
		assertThat(fields(q("since", "2026-13-01"), true)).containsExactly("since");
		// 의도된 축소(design D4): 오프셋 없는 시각과 비 ISO 문자열은 JS만 받는다.
		assertThat(fields(q("since", "2026-10-01T00:00:00"), true)).containsExactly("since");
		assertThat(fields(q("since", "Oct 1 2026"), true)).containsExactly("since");
		assertThat(fields(q("worker", "nope", "since", "abc"), true)).containsExactly("worker", "since");
	}

	@Test
	void parseErrorsAreInvalidRequestExceptions() {
		assertThatThrownBy(() -> WorkerRunQueryParser.parseList(q("page", "x")))
				.isInstanceOf(InvalidRequestException.class);
	}

}
