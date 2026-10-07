package com.auctionboss.bookmark;

import java.time.Instant;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;

/** 관심 물건 (테이블 bookmarks). item_id가 PK이자 items 외래 키다. */
@Entity
@Table(name = "bookmarks")
public class Bookmark {

	@Id
	@Column(name = "item_id")
	private Long itemId;

	@Column(name = "created_at", nullable = false)
	private Instant createdAt;

	protected Bookmark() {
	}

	public Bookmark(Long itemId, Instant createdAt) {
		this.itemId = itemId;
		this.createdAt = createdAt;
	}

	public Long getItemId() {
		return itemId;
	}

	public Instant getCreatedAt() {
		return createdAt;
	}

}
