package com.auctionboss.bookmark;

import java.time.Instant;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;

/** 피드 마지막 읽음 시각 (테이블 feed_reads). CHECK로 id는 항상 1인 단일 행이다. */
@Entity
@Table(name = "feed_reads")
public class FeedRead {

	public static final int SINGLE_ROW_ID = 1;

	@Id
	private Integer id;

	@Column(name = "last_read_at")
	private Instant lastReadAt;

	protected FeedRead() {
	}

	public FeedRead(Instant lastReadAt) {
		this.id = SINGLE_ROW_ID;
		this.lastReadAt = lastReadAt;
	}

	public Integer getId() {
		return id;
	}

	public Instant getLastReadAt() {
		return lastReadAt;
	}

}
