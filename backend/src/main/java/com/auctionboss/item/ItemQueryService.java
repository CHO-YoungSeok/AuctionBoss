package com.auctionboss.item;

import java.util.List;

import com.auctionboss.analysis.AnalysisRepository;
import com.auctionboss.analysis.AnalysisResponse;
import com.auctionboss.common.error.FieldIssue;
import com.auctionboss.common.error.InvalidRequestException;
import com.auctionboss.history.ItemChangeRepository;
import com.auctionboss.history.ItemChangeResponse;
import com.auctionboss.item.dto.ItemDetailResponse;
import com.auctionboss.item.search.ItemPage;
import com.auctionboss.item.search.ItemQueryParser;
import com.auctionboss.item.search.ItemSearchRepository;
import com.auctionboss.item.search.ParseResult;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.util.MultiValueMap;

/** 물건 읽기 조회를 묶는다. 컨트롤러는 HTTP 변환만 한다. */
@Service
@Transactional(readOnly = true)
public class ItemQueryService {

	private final ItemSearchRepository search;

	private final ItemRepository items;

	private final AnalysisRepository analyses;

	private final ItemChangeRepository changes;

	public ItemQueryService(ItemSearchRepository search, ItemRepository items, AnalysisRepository analyses,
			ItemChangeRepository changes) {
		this.search = search;
		this.items = items;
		this.analyses = analyses;
		this.changes = changes;
	}

	public ItemPage list(MultiValueMap<String, String> params) {
		ParseResult result = ItemQueryParser.parse(params);
		if (result instanceof ParseResult.Failure failure) {
			List<FieldIssue> issues = failure.issues();
			throw new InvalidRequestException(issues);
		}
		return search.search(((ParseResult.Success) result).condition());
	}

	/** 물건 1건 + 최신 분석. 쿼리 2개(물건 + 서브쿼리 컬럼, 최신 분석). */
	public ItemDetailResponse detail(String rawId) {
		long id = parseId(rawId);
		var item = search.findDetail(id).orElseThrow(() -> new ItemNotFoundException(rawId));
		AnalysisResponse analysis = analyses.findFirstByItem_IdOrderByAnalyzedAtDescIdDesc(id)
				.map(a -> AnalysisResponse.of(a, id)).orElse(null);
		return new ItemDetailResponse(item, analysis);
	}

	public List<ItemChangeResponse> changes(String rawId) {
		long id = parseId(rawId);
		if (!items.existsById(id)) {
			throw new ItemNotFoundException(rawId);
		}
		return changes.findByItem_IdOrderByChangedAtAscIdAsc(id).stream().map(c -> ItemChangeResponse.of(c, id))
				.toList();
	}

	public List<String> usageTypes() {
		return items.listUsageTypes();
	}

	/** 숫자(^\d+$)가 아니거나 long 범위를 넘으면 없는 물건과 같게 404로 보낸다. */
	private static long parseId(String raw) {
		if (!raw.matches("\\d+")) {
			throw new ItemNotFoundException(raw);
		}
		try {
			return Long.parseLong(raw);
		}
		catch (NumberFormatException e) {
			throw new ItemNotFoundException(raw);
		}
	}

}
