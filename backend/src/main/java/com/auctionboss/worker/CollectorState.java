package com.auctionboss.worker;

import java.time.Instant;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;

/** 수집기 상태 키-값 (테이블 collector_state). 이번 change에서는 매핑만 둔다. */
@Entity
@Table(name = "collector_state")
public class CollectorState {

	// key는 MySQL 예약어라 컬럼 단위로 백틱 처리한다.
	@Id
	@Column(name = "`key`", length = 100, nullable = false)
	private String key;

	@Column(name = "value", nullable = false, length = 65535)
	private String value;

	// DATETIME(3), 항상 UTC.
	@Column(name = "updated_at", nullable = false)
	private Instant updatedAt;

	protected CollectorState() {
	}

	public CollectorState(String key, String value, Instant updatedAt) {
		this.key = key;
		this.value = value;
		this.updatedAt = updatedAt;
	}

	public String getKey() {
		return key;
	}

	public String getValue() {
		return value;
	}

	public Instant getUpdatedAt() {
		return updatedAt;
	}

}
