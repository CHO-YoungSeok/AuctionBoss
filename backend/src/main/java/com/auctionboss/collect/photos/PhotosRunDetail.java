package com.auctionboss.collect.photos;

import java.util.LinkedHashMap;
import java.util.Map;

/** 사진 회차의 {@code worker_runs.detail}(TS {@code PhotosRunDetail}). {@code requestsMade}는 소스가 실제로 보낸 요청 수다. */
public record PhotosRunDetail(int attempted, int collected, int empty, int failed, int requestsMade) {

	/** JSON 키 순서는 TS와 같다. */
	public Map<String, Object> toMap() {
		Map<String, Object> map = new LinkedHashMap<>();
		map.put("attempted", attempted);
		map.put("collected", collected);
		map.put("empty", empty);
		map.put("failed", failed);
		map.put("requestsMade", requestsMade);
		return map;
	}

}
