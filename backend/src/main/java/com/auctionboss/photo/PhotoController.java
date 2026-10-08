package com.auctionboss.photo;

import java.nio.charset.StandardCharsets;
import java.util.Optional;
import java.util.OptionalDouble;

import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RestController;

/**
 * 사진 파일 API. 원본 {@code GET /api/photos/[itemId]/[seq]}와 같은 계약이다. 오류 본문은 JSON이 아니라 텍스트다
 * ({@code Invalid ID}, {@code Not Found}, {@code File Not Found}). id와 순번은 JS {@code parseInt}처럼 앞쪽 정수만
 * 읽는다({@code 12abc}는 12).
 */
@RestController
public class PhotoController {

	private static final String CACHE_CONTROL = "public, max-age=86400, immutable";

	private final ItemPhotoRepository photos;

	private final PhotoFileStore store;

	public PhotoController(ItemPhotoRepository photos, PhotoFileStore store) {
		this.photos = photos;
		this.store = store;
	}

	@GetMapping("/api/photos/{itemId}/{seq}")
	ResponseEntity<?> photo(@PathVariable String itemId, @PathVariable String seq) {
		OptionalDouble itemIdValue = JsInts.parseInt(itemId);
		OptionalDouble seqValue = JsInts.parseInt(seq);
		if (itemIdValue.isEmpty() || seqValue.isEmpty()) {
			return text(HttpStatus.BAD_REQUEST, "Invalid ID");
		}
		// BIGINT id와 INT 순번의 범위 밖 값은 어떤 기록도 아니다.
		double id = itemIdValue.getAsDouble();
		double no = seqValue.getAsDouble();
		if (id >= 9.2e18 || id <= -9.2e18 || no > Integer.MAX_VALUE || no < Integer.MIN_VALUE) {
			return text(HttpStatus.NOT_FOUND, "Not Found");
		}
		Optional<ItemPhoto> photo = photos.findByItem_IdAndSeq((long) id, (int) no);
		if (photo.isEmpty()) {
			return text(HttpStatus.NOT_FOUND, "Not Found");
		}
		Optional<byte[]> bytes = store.read(photo.get().getFilePath());
		if (bytes.isEmpty()) {
			return text(HttpStatus.NOT_FOUND, "File Not Found");
		}
		HttpHeaders headers = new HttpHeaders();
		headers.set(HttpHeaders.CONTENT_TYPE, photo.get().getMimeType());
		headers.set(HttpHeaders.CACHE_CONTROL, CACHE_CONTROL);
		return new ResponseEntity<>(bytes.get(), headers, HttpStatus.OK);
	}

	private static ResponseEntity<String> text(HttpStatus status, String body) {
		return ResponseEntity.status(status).contentType(new MediaType("text", "plain", StandardCharsets.UTF_8))
				.body(body);
	}

}
