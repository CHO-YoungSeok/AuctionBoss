package com.auctionboss.worker;

import java.time.Instant;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.time.format.DateTimeParseException;
import java.util.List;
import java.util.Map;

import com.auctionboss.common.query.PageParams;

/**
 * {@code GET /api/worker-runs}, {@code /summary}의 URL 파라미터 검증. 원본 {@code worker-run-query.ts}와 같은 규칙과 이슈
 * 순서(worker, outcome, page, pageSize / worker, since)다.
 *
 * <p>
 * {@code since}는 의도적으로 좁혔다. 원본은 JS {@code new Date()}가 해석하는 모든 문자열을 받지만 여기서는 ISO-8601 날짜
 * ({@code 2026-10-01}, 그 날 UTC 0시)와 {@code Z} 또는 오프셋이 있는 날짜·시각만 받는다.
 */
final class WorkerRunQueryParser {

	private static final List<String> OUTCOMES = List.of("running", "success", "failed", "blocked", "skipped");

	record ListQuery(String worker, RunOutcome outcome, PageParams.Page page) {
	}

	record SummaryQuery(String worker, Instant since) {
	}

	private WorkerRunQueryParser() {
	}

	static ListQuery parseList(Map<String, List<String>> params) {
		PageParams p = PageParams.of(params);
		String worker = worker(p);
		RunOutcome outcome = outcome(p);
		PageParams.Page page = p.page();
		p.throwIfInvalid();
		return new ListQuery(worker, outcome, page);
	}

	static SummaryQuery parseSummary(Map<String, List<String>> params) {
		PageParams p = PageParams.of(params);
		String worker = worker(p);
		Instant since = since(p);
		p.throwIfInvalid();
		return new SummaryQuery(worker, since);
	}

	private static String worker(PageParams p) {
		String raw = p.read("worker");
		if (raw == null) {
			return null;
		}
		if (!WorkerKind.ALL.contains(raw)) {
			p.issue("worker", "worker는 " + String.join(", ", WorkerKind.ALL) + " 중 하나여야 합니다");
			return null;
		}
		return raw;
	}

	private static RunOutcome outcome(PageParams p) {
		String raw = p.read("outcome");
		if (raw == null) {
			return null;
		}
		if (!OUTCOMES.contains(raw)) {
			p.issue("outcome", "outcome은 " + String.join(", ", OUTCOMES) + " 중 하나여야 합니다");
			return null;
		}
		return RunOutcome.fromDb(raw);
	}

	private static Instant since(PageParams p) {
		String raw = p.read("since");
		if (raw == null) {
			return null;
		}
		Instant parsed = parseInstant(raw);
		if (parsed == null) {
			p.issue("since", "since는 올바른 ISO 날짜·시각이어야 합니다");
		}
		return parsed;
	}

	/** 날짜만이면 UTC 0시, 아니면 오프셋이 있는 날짜·시각. 해석할 수 없으면 null. */
	static Instant parseInstant(String raw) {
		try {
			return LocalDate.parse(raw).atStartOfDay().toInstant(ZoneOffset.UTC);
		}
		catch (DateTimeParseException ignored) {
			// 날짜·시각으로 다시 시도한다.
		}
		try {
			return OffsetDateTime.parse(raw).toInstant();
		}
		catch (DateTimeParseException e) {
			return null;
		}
	}

}
