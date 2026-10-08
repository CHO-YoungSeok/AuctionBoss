package com.auctionboss.item;

import java.util.List;
import java.util.Map;

import com.auctionboss.history.ItemChangeResponse;
import com.auctionboss.item.dto.ItemDetailResponse;
import com.auctionboss.item.search.ItemPage;
import org.springframework.util.MultiValueMap;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/** 물건 조회 API. 원본 Next.js 라우트({@code /api/items/**})와 같은 계약이다. */
@RestController
@RequestMapping("/api/items")
public class ItemController {

	private final ItemQueryService service;

	public ItemController(ItemQueryService service) {
		this.service = service;
	}

	@GetMapping
	ItemPage list(@RequestParam MultiValueMap<String, String> params) {
		return service.list(params);
	}

	// 리터럴 경로가 {id} 패턴보다 우선하므로 usage-types가 id로 잡히지 않는다.
	@GetMapping("/usage-types")
	Map<String, List<String>> usageTypes() {
		return Map.of("usageTypes", service.usageTypes());
	}

	@GetMapping("/{id}")
	ItemDetailResponse detail(@PathVariable String id) {
		return service.detail(id);
	}

	@GetMapping("/{id}/changes")
	Map<String, List<ItemChangeResponse>> changes(@PathVariable String id) {
		return Map.of("changes", service.changes(id));
	}

}
