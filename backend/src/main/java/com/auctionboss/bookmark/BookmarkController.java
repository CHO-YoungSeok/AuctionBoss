package com.auctionboss.bookmark;

import com.auctionboss.item.search.ItemPage;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.util.MultiValueMap;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/** 관심 물건 API. 원본 Next.js 라우트({@code /api/bookmarks/**})와 같은 계약이다. 화면 전용 폼 엔드포인트는 이 단계 밖이다. */
@RestController
@RequestMapping("/api/bookmarks")
public class BookmarkController {

	private final BookmarkService service;

	public BookmarkController(BookmarkService service) {
		this.service = service;
	}

	@GetMapping
	ItemPage list(@RequestParam MultiValueMap<String, String> params) {
		return service.list(params);
	}

	@PostMapping
	ResponseEntity<BookmarkAddedResponse> add(@RequestBody(required = false) byte[] body) {
		return ResponseEntity.status(HttpStatus.CREATED).body(service.add(body));
	}

	@DeleteMapping("/{itemId}")
	BookmarkRemovedResponse remove(@PathVariable String itemId) {
		return service.remove(itemId);
	}

}
