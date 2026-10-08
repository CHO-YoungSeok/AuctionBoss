package com.auctionboss.photo;

import java.time.Instant;

/** 사진 목록 항목. 서버의 파일 경로는 넣지 않는다. 필드 이름과 순서는 Next {@code /api/items/{id}/photos}와 같다. */
public record PhotoMetaResponse(Long id, Long itemId, Integer seq, Long fileSize, String mimeType,
		Instant collectedAt) {

	public static PhotoMetaResponse of(ItemPhoto p, long itemId) {
		return new PhotoMetaResponse(p.getId(), itemId, p.getSeq(), p.getFileSize(), p.getMimeType(),
				p.getCollectedAt());
	}

}
