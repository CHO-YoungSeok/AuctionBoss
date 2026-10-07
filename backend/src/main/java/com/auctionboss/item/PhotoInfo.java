package com.auctionboss.item;

import java.time.Instant;

import com.auctionboss.photo.PhotoStatus;
import com.auctionboss.photo.PhotoStatusConverter;
import jakarta.persistence.Column;
import jakarta.persistence.Convert;
import jakarta.persistence.Embeddable;

/** 사진 수집 상태 요약. 사진 메타데이터 자체는 item_photos에 있다. */
@Embeddable
public record PhotoInfo(
		@Convert(converter = PhotoStatusConverter.class) @Column(name = "photo_status", length = 20) PhotoStatus photoStatus,
		Integer photoCount, Instant photoCollectedAt) {
}
