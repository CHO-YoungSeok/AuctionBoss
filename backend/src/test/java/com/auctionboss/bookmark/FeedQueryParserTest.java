package com.auctionboss.bookmark;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import com.auctionboss.common.error.FieldIssue;
import com.auctionboss.common.error.InvalidRequestException;
import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.Test;

/**
 * 4.1: 원본 {@code feed-query.ts}의 페이지·{@code sinceBookmarkedAt} 규칙(정수 형식, 1 이상, 200 이하,
 * {@code true}/{@code false}, 빈 값). 원본에는 파서 단위 테스트가 없어 스키마의 규칙마다 사례를 만들었다.
 */
class FeedQueryParserTest {

	private static Map<String, List<String>> q(String... kv) {
		Map<String, List<String>> m = new LinkedHashMap<>();
		for (int i = 0; i < kv.length; i += 2) {
			m.computeIfAbsent(kv[i], k -> new ArrayList<>()).add(kv[i + 1]);
		}
		return m;
	}

	private static List<String> pageFields(String... kv) {
		return fieldsOf(() -> FeedQueryParser.parsePage(q(kv)));
	}

	private static List<String> feedFields(String... kv) {
		return fieldsOf(() -> FeedQueryParser.parseFeed(q(kv)));
	}

	private static List<String> fieldsOf(org.junit.jupiter.api.function.Executable call) {
		InvalidRequestException e = Assertions.assertThrows(InvalidRequestException.class, call);
		assertThat(e.getMessage()).isEqualTo("잘못된 요청 파라미터입니다");
		return e.getIssues().stream().map(FieldIssue::field).toList();
	}

	@Test
	void defaultsAreFirstPageOfTwenty() {
		assertThat(FeedQueryParser.parsePage(q()).page()).isEqualTo(1);
		assertThat(FeedQueryParser.parsePage(q()).pageSize()).isEqualTo(20);
		FeedQueryParser.FeedQuery feed = FeedQueryParser.parseFeed(q());
		assertThat(feed.sinceBookmarkedAt()).isFalse();
		assertThat(feed.page().pageSize()).isEqualTo(20);
	}

	@Test
	void validValuesAreAccepted() {
		FeedQueryParser.FeedQuery feed = FeedQueryParser
				.parseFeed(q("page", "2", "pageSize", "200", "sinceBookmarkedAt", "true"));

		assertThat(feed.page().page()).isEqualTo(2);
		assertThat(feed.page().pageSize()).isEqualTo(200);
		assertThat(feed.sinceBookmarkedAt()).isTrue();
		assertThat(FeedQueryParser.parseFeed(q("sinceBookmarkedAt", "false")).sinceBookmarkedAt()).isFalse();
		assertThat(FeedQueryParser.parsePage(q("pageSize", " 1 ")).pageSize()).isEqualTo(1);
	}

	@Test
	void integerFormatMinimumAndMaximumAreChecked() {
		assertThat(pageFields("page", "abc")).containsExactly("page");
		assertThat(pageFields("page", "1.5")).containsExactly("page");
		assertThat(pageFields("page", "-1")).containsExactly("page");
		assertThat(pageFields("page", "0")).containsExactly("page");
		assertThat(pageFields("pageSize", "0")).containsExactly("pageSize");
		assertThat(pageFields("pageSize", "201")).containsExactly("pageSize");
		assertThat(pageFields("page", "99999999999999999999")).containsExactly("page");
		assertThat(pageFields("pageSize", "99999999999999999999")).containsExactly("pageSize", "pageSize");
		assertThat(pageFields("page", "0", "pageSize", "0")).containsExactly("page", "pageSize");
	}

	@Test
	void recognizedParametersWithEmptyValuesAreIssues() {
		assertThat(pageFields("page", "")).containsExactly("page");
		assertThat(pageFields("pageSize", "   ")).containsExactly("pageSize");
		assertThat(feedFields("sinceBookmarkedAt", "")).containsExactly("sinceBookmarkedAt");
	}

	@Test
	void sinceBookmarkedAtOnlyAcceptsLowercaseTrueAndFalse() {
		for (String bad : List.of("yes", "1", "TRUE", "True", "0", "on")) {
			assertThat(feedFields("sinceBookmarkedAt", bad)).as(bad).containsExactly("sinceBookmarkedAt");
		}
	}

	@Test
	void feedIssuesFollowSchemaOrderPageThenPageSizeThenSince() {
		assertThat(feedFields("sinceBookmarkedAt", "x", "pageSize", "0", "page", "0"))
				.containsExactly("page", "pageSize", "sinceBookmarkedAt");
		assertThat(Assertions.assertThrows(InvalidRequestException.class,
				() -> FeedQueryParser.parseFeed(q("sinceBookmarkedAt", "yes"))).getIssues())
						.containsExactly(new FieldIssue("sinceBookmarkedAt", "sinceBookmarkedAt은 true 또는 false여야 합니다"));
	}

	@Test
	void sinceBookmarkedAtIsIgnoredForTheBookmarkListAndUnknownParametersToo() {
		assertThat(FeedQueryParser.parsePage(q("sinceBookmarkedAt", "yes", "foo", "bar")).page()).isEqualTo(1);
	}

}
