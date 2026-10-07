package com.auctionboss.history;

import java.time.Instant;

import com.auctionboss.item.Item;
import jakarta.persistence.Column;
import jakarta.persistence.Convert;
import jakarta.persistence.Entity;
import jakarta.persistence.FetchType;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.JoinColumn;
import jakarta.persistence.ManyToOne;
import jakarta.persistence.Table;

/** 감시 대상 필드의 변경 이력 (테이블 item_changes). */
@Entity
@Table(name = "item_changes")
public class ItemChange {

	@Id
	@GeneratedValue(strategy = GenerationType.IDENTITY)
	private Long id;

	@ManyToOne(fetch = FetchType.LAZY, optional = false)
	@JoinColumn(name = "item_id", nullable = false)
	private Item item;

	@Column(name = "field", nullable = false, length = 50)
	private String field;

	@Column(name = "old_value", length = 65535)
	private String oldValue;

	@Column(name = "new_value", length = 65535)
	private String newValue;

	@Column(name = "changed_at", nullable = false)
	private Instant changedAt;

	@Convert(converter = ChangeKindConverter.class)
	@Column(name = "kind", nullable = false, length = 20)
	private ChangeKind kind;

	protected ItemChange() {
	}

	public ItemChange(Item item, String field, String oldValue, String newValue, Instant changedAt, ChangeKind kind) {
		this.item = item;
		this.field = field;
		this.oldValue = oldValue;
		this.newValue = newValue;
		this.changedAt = changedAt;
		this.kind = kind;
	}

	public Long getId() {
		return id;
	}

	public Item getItem() {
		return item;
	}

	public String getField() {
		return field;
	}

	public String getOldValue() {
		return oldValue;
	}

	public String getNewValue() {
		return newValue;
	}

	public Instant getChangedAt() {
		return changedAt;
	}

	public ChangeKind getKind() {
		return kind;
	}

}
