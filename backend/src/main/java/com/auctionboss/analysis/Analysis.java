package com.auctionboss.analysis;

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

/** AI 분석 결과 (테이블 analyses). 물건당 여러 건이 쌓이고 최신 건이 화면에 쓰인다. */
@Entity
@Table(name = "analyses")
public class Analysis {

	@Id
	@GeneratedValue(strategy = GenerationType.IDENTITY)
	private Long id;

	@ManyToOne(fetch = FetchType.LAZY, optional = false)
	@JoinColumn(name = "item_id", nullable = false)
	private Item item;

	@Column(name = "body", nullable = false, length = 16777215)
	private String body;

	@Column(name = "model", length = 255)
	private String model;

	@Column(name = "prompt_version", nullable = false, length = 255)
	private String promptVersion;

	@Column(name = "analyzed_at", nullable = false)
	private Instant analyzedAt;

	protected Analysis() {
	}

	public Analysis(Item item, String body, String model, String promptVersion, Instant analyzedAt) {
		this.item = item;
		this.body = body;
		this.model = model;
		this.promptVersion = promptVersion;
		this.analyzedAt = analyzedAt;
	}

	public Long getId() {
		return id;
	}

	public Item getItem() {
		return item;
	}

	public String getBody() {
		return body;
	}

	public String getModel() {
		return model;
	}

	public String getPromptVersion() {
		return promptVersion;
	}

	public Instant getAnalyzedAt() {
		return analyzedAt;
	}

}
