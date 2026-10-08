package com.auctionboss.item;

import java.util.List;

import com.auctionboss.analysis.AnalysisHistoryResponse;
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
import com.auctionboss.common.query.PageParams;
import com.auctionboss.photo.ItemPhotoRepository;
import com.auctionboss.photo.PhotoMetaResponse;
import org.springframework.data.domain.PageRequest;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.util.MultiValueMap;

/** 물건 읽기 조회를 묶는다. 컨트롤러는 HTTP 변환만 한다. */
@Service
@Transactional(readOnly = true)
public class ItemQueryService {

	static final int DEFAULT_ANALYSES_LIMIT = 10;

	static final int MAX_ANALYSES_LIMIT = 50;

	private final ItemSearchRepository search;

	private final ItemRepository items;

	private final AnalysisRepository analyses;

	private final ItemChangeRepository changes;

	private final ItemFilterOptionsRepository filterOptions;

	private final ItemPhotoRepository photos;

	public ItemQueryService(ItemSearchRepository search, ItemRepository items, AnalysisRepository analyses,
			ItemChangeRepository changes, ItemFilterOptionsRepository filterOptions, ItemPhotoRepository photos) {
		this.search = search;
		this.items = items;
		this.analyses = analyses;
		this.changes = changes;
		this.filterOptions = filterOptions;
		this.photos = photos;
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

	/** 선택지 4종. 쿼리 4개(용도, 법원, 시도, 시군구). */
	public FilterOptionsResponse filterOptions() {
		return new FilterOptionsResponse(items.listUsageTypes(), filterOptions.sidoValues(),
				filterOptions.sigunguValues(), filterOptions.courtValues());
	}

	/**
	 * 분석 이력. 쿼리 3개(존재, 목록, 건수). 존재 확인이 {@code limit} 검증보다 먼저다(원본과 같은 순서). 존재하지 않는 물건은 404,
	 * 잘못된 {@code limit}은 400이다.
	 */
	public AnalysisHistoryResponse analysisHistory(String rawId, MultiValueMap<String, String> params) {
		long id = parseId(rawId);
		if (!items.existsById(id)) {
			throw new ItemNotFoundException(rawId);
		}
		int limit = parseLimit(params);
		List<AnalysisResponse> list = analyses.findByItem_IdOrderByAnalyzedAtDescIdDesc(id, PageRequest.of(0, limit))
				.stream().map(a -> AnalysisResponse.of(a, id)).toList();
		return new AnalysisHistoryResponse(list, analyses.countByItem_Id(id));
	}

	/** 사진 목록. 쿼리 2개(존재, 목록). 파일 경로는 넣지 않는다. */
	public List<PhotoMetaResponse> photos(String rawId) {
		long id = parseId(rawId);
		if (!items.existsById(id)) {
			throw new ItemNotFoundException(rawId);
		}
		return photos.findByItem_IdOrderBySeqAsc(id).stream().map(p -> PhotoMetaResponse.of(p, id)).toList();
	}

	/** {@code limit}: 1~50 정수, 생략하면 10(원본 {@code analyses-query.ts}와 같다). */
	static int parseLimit(MultiValueMap<String, String> params) {
		PageParams p = PageParams.of(params);
		Long limit = p.integer("limit", 1, (long) MAX_ANALYSES_LIMIT);
		p.throwIfInvalid();
		return limit == null ? DEFAULT_ANALYSES_LIMIT : limit.intValue();
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
