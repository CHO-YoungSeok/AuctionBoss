package com.auctionboss.bookmark;

import java.time.Instant;

import com.auctionboss.common.time.ServerClock;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.util.MultiValueMap;

/** 변동 피드. 조회만으로는 읽음 처리가 되지 않는다. */
@Service
public class FeedService {

	private final BookmarkQueryRepository queries;

	private final BookmarkWriteRepository writes;

	private final ServerClock clock;

	FeedService(BookmarkQueryRepository queries, BookmarkWriteRepository writes, ServerClock clock) {
		this.queries = queries;
		this.writes = writes;
		this.clock = clock;
	}

	@Transactional(readOnly = true)
	public FeedResponse feed(MultiValueMap<String, String> params) {
		FeedQueryParser.FeedQuery q = FeedQueryParser.parseFeed(params);
		return queries.listFeed(q.page(), q.sinceBookmarkedAt());
	}

	/** 지금을 마지막 확인 시각으로 기록하고 미확인 개수를 돌려준다. 한 트랜잭션이다. */
	@Transactional
	public FeedReadResponse markRead() {
		Instant now = clock.now();
		writes.upsertFeedRead(now);
		return new FeedReadResponse(now, queries.unreadCount());
	}

}
