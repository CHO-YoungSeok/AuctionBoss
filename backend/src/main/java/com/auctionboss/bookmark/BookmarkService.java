package com.auctionboss.bookmark;

import java.time.Instant;
import java.util.regex.Pattern;

import com.auctionboss.common.body.BodyValidator;
import com.auctionboss.common.body.JsonBody;
import com.auctionboss.common.error.ForeignKeyViolations;
import com.auctionboss.common.json.JsNumbers;
import com.auctionboss.common.time.ServerClock;
import com.auctionboss.item.ItemNotFoundException;
import com.auctionboss.item.ItemRepository;
import com.auctionboss.item.search.ItemPage;
import com.auctionboss.item.search.ItemSearchRepository;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.util.MultiValueMap;

/** 관심 물건. 쓰기 하나가 트랜잭션 하나다(존재 확인과 쓰기가 같은 트랜잭션). */
@Service
public class BookmarkService {

	static final String INVALID_ADD = "잘못된 관심 등록 본문입니다";

	private static final Pattern ITEM_ID = Pattern.compile("[0-9]+");

	private final ItemRepository items;

	private final ItemSearchRepository search;

	private final BookmarkWriteRepository writes;

	private final BookmarkQueryRepository queries;

	private final ServerClock clock;

	BookmarkService(ItemRepository items, ItemSearchRepository search, BookmarkWriteRepository writes,
			BookmarkQueryRepository queries, ServerClock clock) {
		this.items = items;
		this.search = search;
		this.writes = writes;
		this.queries = queries;
		this.clock = clock;
	}

	@Transactional(readOnly = true)
	public ItemPage list(MultiValueMap<String, String> params) {
		return queries.listBookmarkedItems(FeedQueryParser.parsePage(params));
	}

	/** 이미 담긴 물건이어도 성공이며 처음 담은 시각은 바뀌지 않는다. */
	@Transactional
	public BookmarkAddedResponse add(byte[] rawBody) {
		BodyValidator v = BodyValidator.of(JsonBody.parse(rawBody));
		Double itemId = v.positiveInteger("itemId", "itemId는 정수여야 합니다", "itemId는 1 이상이어야 합니다");
		v.throwIfInvalid(INVALID_ADD);

		Instant now = clock.now();
		String label = JsNumbers.format(itemId);
		long id = requireExisting(itemId, label);
		try {
			writes.addIfAbsent(id, now);
		}
		catch (DataIntegrityViolationException e) {
			// 확인과 삽입 사이에 물건이 지워진 경우.
			if (ForeignKeyViolations.isMissingParent(e)) {
				throw new ItemNotFoundException(label);
			}
			throw e;
		}
		// bookmarked=true가 채워진 물건을 상세 API와 같은 형태로 돌려준다.
		return new BookmarkAddedResponse(search.findDetail(id).orElseThrow(() -> new ItemNotFoundException(label)));
	}

	/** 담기지 않은 물건을 빼도 오류가 아니다. {@code rawId}는 URL 경로의 원문이다. */
	@Transactional
	public BookmarkRemovedResponse remove(String rawId) {
		if (!ITEM_ID.matcher(rawId).matches()) {
			throw new ItemNotFoundException(rawId);
		}
		double asNumber = Double.parseDouble(rawId);
		long id = requireExisting(asNumber, JsNumbers.format(asNumber));
		writes.remove(id);
		return new BookmarkRemovedResponse(id, false);
	}

	/** 0 < id < 2^63만 BIGINT id가 될 수 있다. 존재하지 않으면 404. */
	private long requireExisting(double itemId, String label) {
		if (itemId >= 9.2e18 || !items.existsById((long) itemId)) {
			throw new ItemNotFoundException(label);
		}
		return (long) itemId;
	}

}
