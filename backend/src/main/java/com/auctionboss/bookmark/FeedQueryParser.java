package com.auctionboss.bookmark;

import java.util.List;
import java.util.Map;

import com.auctionboss.common.query.PageParams;

/** {@code GET /api/bookmarks}, {@code /api/feed}의 URL 파라미터 검증. 원본 {@code feed-query.ts}와 같은 규칙이다. */
final class FeedQueryParser {

	record FeedQuery(PageParams.Page page, boolean sinceBookmarkedAt) {
	}

	private FeedQueryParser() {
	}

	static PageParams.Page parsePage(Map<String, List<String>> params) {
		PageParams p = PageParams.of(params);
		PageParams.Page page = p.page();
		p.throwIfInvalid();
		return page;
	}

	static FeedQuery parseFeed(Map<String, List<String>> params) {
		PageParams p = PageParams.of(params);
		PageParams.Page page = p.page();
		boolean since = false;
		String raw = p.read("sinceBookmarkedAt");
		if (raw != null) {
			if (raw.equals("true") || raw.equals("false")) {
				since = raw.equals("true");
			}
			else {
				p.issue("sinceBookmarkedAt", "sinceBookmarkedAt은 true 또는 false여야 합니다");
			}
		}
		p.throwIfInvalid();
		return new FeedQuery(page, since);
	}

}
