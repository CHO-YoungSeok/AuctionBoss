package com.auctionboss.bookmark;

import org.springframework.util.MultiValueMap;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/** 변동 피드 API. 원본 {@code /api/feed}, {@code /api/feed/read}와 같은 계약이다(읽음 처리는 본문을 읽지 않는다). */
@RestController
@RequestMapping("/api/feed")
public class FeedController {

	private final FeedService service;

	public FeedController(FeedService service) {
		this.service = service;
	}

	@GetMapping
	FeedResponse feed(@RequestParam MultiValueMap<String, String> params) {
		return service.feed(params);
	}

	@PostMapping("/read")
	FeedReadResponse read() {
		return service.markRead();
	}

}
