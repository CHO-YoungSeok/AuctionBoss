package com.auctionboss.worker;

import java.time.Instant;
import java.util.Map;

import jakarta.persistence.Column;
import jakarta.persistence.Convert;
import jakarta.persistence.Entity;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import org.hibernate.annotations.JdbcTypeCode;
import org.hibernate.type.SqlTypes;

/** 워커 실행 기록 (테이블 worker_runs). 이번 change에서는 매핑만 둔다. */
@Entity
@Table(name = "worker_runs")
public class WorkerRun {

	@Id
	@GeneratedValue(strategy = GenerationType.IDENTITY)
	private Long id;

	@Column(name = "worker", nullable = false, length = 20)
	private String worker;

	@Column(name = "started_at", nullable = false)
	private Instant startedAt;

	@Column(name = "finished_at")
	private Instant finishedAt;

	@Convert(converter = RunOutcomeConverter.class)
	@Column(name = "outcome", nullable = false, length = 20)
	private RunOutcome outcome;

	@Column(name = "error_kind", length = 100)
	private String errorKind;

	@Column(name = "error_message", length = 65535)
	private String errorMessage;

	@JdbcTypeCode(SqlTypes.JSON)
	@Column(name = "detail")
	private Map<String, Object> detail;

	@Column(name = "items_changed")
	private Integer itemsChanged;

	@Column(name = "created_at", nullable = false)
	private Instant createdAt;

	protected WorkerRun() {
	}

	public WorkerRun(String worker, Instant startedAt, Instant finishedAt, RunOutcome outcome, String errorKind,
			String errorMessage, Map<String, Object> detail, Integer itemsChanged, Instant createdAt) {
		this.worker = worker;
		this.startedAt = startedAt;
		this.finishedAt = finishedAt;
		this.outcome = outcome;
		this.errorKind = errorKind;
		this.errorMessage = errorMessage;
		this.detail = detail;
		this.itemsChanged = itemsChanged;
		this.createdAt = createdAt;
	}

	public Long getId() {
		return id;
	}

	public String getWorker() {
		return worker;
	}

	public Instant getStartedAt() {
		return startedAt;
	}

	public Instant getFinishedAt() {
		return finishedAt;
	}

	public RunOutcome getOutcome() {
		return outcome;
	}

	public String getErrorKind() {
		return errorKind;
	}

	public String getErrorMessage() {
		return errorMessage;
	}

	public Map<String, Object> getDetail() {
		return detail;
	}

	public Integer getItemsChanged() {
		return itemsChanged;
	}

	public Instant getCreatedAt() {
		return createdAt;
	}

}
