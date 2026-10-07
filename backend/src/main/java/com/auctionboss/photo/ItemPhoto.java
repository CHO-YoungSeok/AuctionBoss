package com.auctionboss.photo;

import java.time.Instant;

import com.auctionboss.item.Item;
import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.FetchType;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.JoinColumn;
import jakarta.persistence.ManyToOne;
import jakarta.persistence.Table;

/** 물건 사진 메타데이터 (테이블 item_photos). */
@Entity
@Table(name = "item_photos")
public class ItemPhoto {

	@Id
	@GeneratedValue(strategy = GenerationType.IDENTITY)
	private Long id;

	@ManyToOne(fetch = FetchType.LAZY, optional = false)
	@JoinColumn(name = "item_id", nullable = false)
	private Item item;

	@Column(name = "seq", nullable = false)
	private Integer seq;

	@Column(name = "file_path", nullable = false, length = 500)
	private String filePath;

	@Column(name = "file_size", nullable = false)
	private Long fileSize;

	@Column(name = "mime_type", nullable = false, length = 100)
	private String mimeType;

	@Column(name = "collected_at", nullable = false)
	private Instant collectedAt;

	protected ItemPhoto() {
	}

	public ItemPhoto(Item item, Integer seq, String filePath, Long fileSize, String mimeType, Instant collectedAt) {
		this.item = item;
		this.seq = seq;
		this.filePath = filePath;
		this.fileSize = fileSize;
		this.mimeType = mimeType;
		this.collectedAt = collectedAt;
	}

	public Long getId() {
		return id;
	}

	public Item getItem() {
		return item;
	}

	public Integer getSeq() {
		return seq;
	}

	public String getFilePath() {
		return filePath;
	}

	public Long getFileSize() {
		return fileSize;
	}

	public String getMimeType() {
		return mimeType;
	}

	public Instant getCollectedAt() {
		return collectedAt;
	}

}
