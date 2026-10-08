package com.auctionboss.history;

import java.time.Instant;

/** 변경 이력 응답. 필드 이름과 순서는 원본 {@code ItemChange}(toItemChange)와 같다. */
public record ItemChangeResponse(Long id, Long itemId, String field, String oldValue, String newValue,
		Instant changedAt, String kind) {

	public static ItemChangeResponse of(ItemChange c, long itemId) {
		return new ItemChangeResponse(c.getId(), itemId, c.getField(), c.getOldValue(), c.getNewValue(),
				c.getChangedAt(), c.getKind().dbValue());
	}

}
