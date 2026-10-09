package com.auctionboss.collect.collector;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 수집 회차의 {@code worker_runs.detail}(TS {@code CollectorRunDetail}). {@code targetCourts}는 이번 회차가 실제로 처리(시도)한 법원만
 * 담는다. {@code pagesRequested}는 소스가 실제로 요청한 수(실패한 법원은 오류가 실어 보낸 값)다.
 */
public record CollectorRunDetail(List<String> targetCourts, int pagesRequested, int itemsFetched, int inserted,
		int updated, int changed) {

	/** JSON 키 순서는 TS와 같다. */
	public Map<String, Object> toMap() {
		Map<String, Object> map = new LinkedHashMap<>();
		map.put("targetCourts", targetCourts);
		map.put("pagesRequested", pagesRequested);
		map.put("itemsFetched", itemsFetched);
		map.put("inserted", inserted);
		map.put("updated", updated);
		map.put("changed", changed);
		return map;
	}

}
