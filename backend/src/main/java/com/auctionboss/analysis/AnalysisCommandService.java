package com.auctionboss.analysis;

import java.time.Instant;

import com.auctionboss.common.error.ForeignKeyViolations;
import com.auctionboss.common.json.JsNumbers;
import com.auctionboss.common.time.ServerClock;
import com.auctionboss.item.Item;
import com.auctionboss.item.ItemNotFoundException;
import com.auctionboss.item.ItemRepository;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/** 분석 결과 저장. 물건 존재 확인과 저장은 한 트랜잭션이다. */
@Service
public class AnalysisCommandService {

	private final ItemRepository items;

	private final AnalysisRepository analyses;

	private final ServerClock clock;

	public AnalysisCommandService(ItemRepository items, AnalysisRepository analyses, ServerClock clock) {
		this.items = items;
		this.analyses = analyses;
		this.clock = clock;
	}

	@Transactional
	public AnalysisResponse create(NewAnalysis in) {
		Instant now = clock.now();
		String label = JsNumbers.format(in.itemId());
		// 0 < itemId < 2^63만 BIGINT id가 될 수 있다. 그 밖의 값은 어떤 물건도 아니다.
		if (in.itemId() >= 9.2e18) {
			throw new ItemNotFoundException(label);
		}
		long itemId = (long) in.itemId();
		if (!items.existsById(itemId)) {
			throw new ItemNotFoundException(label);
		}
		Item ref = items.getReferenceById(itemId);
		try {
			Analysis saved = analyses.saveAndFlush(new Analysis(ref, in.body(), in.model(), in.promptVersion(), now));
			return AnalysisResponse.of(saved, itemId);
		}
		catch (DataIntegrityViolationException e) {
			// 확인과 삽입 사이에 물건이 지워진 경우. 확인 실패와 같게 404로 보낸다.
			if (ForeignKeyViolations.isMissingParent(e)) {
				throw new ItemNotFoundException(label);
			}
			throw e;
		}
	}

}
