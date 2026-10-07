package com.auctionboss.item;

import java.time.Instant;
import java.time.LocalDate;

import jakarta.persistence.Column;
import jakarta.persistence.Embedded;
import jakarta.persistence.Entity;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import jakarta.persistence.UniqueConstraint;

/**
 * 경매 물건 (테이블 items). 컬럼은 SQLite와 1:1이고, 코드 가독성을 위해 일부를 값 객체로 묶는다.
 * 값 객체의 컬럼이 전부 NULL이면 Hibernate는 그 필드를 null로 읽는다.
 */
@Entity
@Table(name = "items", uniqueConstraints = @UniqueConstraint(name = "uq_items_court_case_item", columnNames = {
		"court", "case_no", "item_no" }))
public class Item {

	@Id
	@GeneratedValue(strategy = GenerationType.IDENTITY)
	private Long id;

	// 자연 키 (court, case_no, item_no)
	@Column(name = "court", nullable = false, length = 50)
	private String court;

	@Column(name = "case_no", nullable = false, length = 50)
	private String caseNo;

	@Column(name = "item_no", nullable = false, length = 20)
	private String itemNo;

	@Column(name = "usage_type", length = 100)
	private String usageType;

	// 금액은 원 단위 BIGINT. 최대 감정가가 51,005,255,120원이라 INT로는 모자란다.
	@Column(name = "appraisal_price")
	private Long appraisalPrice;

	@Column(name = "min_bid_price")
	private Long minBidPrice;

	@Column(name = "failed_bid_count")
	private Integer failedBidCount;

	@Column(name = "status", length = 50)
	private String status;

	@Column(name = "first_seen_at", nullable = false)
	private Instant firstSeenAt;

	@Column(name = "last_seen_at", nullable = false)
	private Instant lastSeenAt;

	@Column(name = "min_area")
	private Integer minArea;

	@Column(name = "max_area")
	private Integer maxArea;

	@Column(name = "building_description", length = 65535)
	private String buildingDescription;

	@Column(name = "note", length = 65535)
	private String note;

	@Column(name = "duplicate_case_no", length = 500)
	private String duplicateCaseNo;

	@Column(name = "merged_case_no", length = 500)
	private String mergedCaseNo;

	@Embedded
	private Location location;

	@Embedded
	private AuctionSchedule schedule;

	@Embedded
	private PriceRounds priceRounds;

	@Embedded
	private UsageCodes usageCodes;

	@Embedded
	private CourtContact courtContact;

	@Embedded
	private SourceIds sourceIds;

	@Embedded
	private PhotoInfo photoInfo;

	protected Item() {
	}

	private Item(Builder b) {
		this.court = b.court;
		this.caseNo = b.caseNo;
		this.itemNo = b.itemNo;
		this.usageType = b.usageType;
		this.appraisalPrice = b.appraisalPrice;
		this.minBidPrice = b.minBidPrice;
		this.failedBidCount = b.failedBidCount;
		this.status = b.status;
		this.firstSeenAt = b.firstSeenAt;
		this.lastSeenAt = b.lastSeenAt;
		this.minArea = b.minArea;
		this.maxArea = b.maxArea;
		this.buildingDescription = b.buildingDescription;
		this.note = b.note;
		this.duplicateCaseNo = b.duplicateCaseNo;
		this.mergedCaseNo = b.mergedCaseNo;
		this.location = b.location;
		this.schedule = b.schedule;
		this.priceRounds = b.priceRounds;
		this.usageCodes = b.usageCodes;
		this.courtContact = b.courtContact;
		this.sourceIds = b.sourceIds;
		this.photoInfo = b.photoInfo;
	}

	/** 자연 키와 수집 시각은 필수다. 나머지는 빌더에서 채운다. */
	public static Builder builder(String court, String caseNo, String itemNo, Instant firstSeenAt,
			Instant lastSeenAt) {
		return new Builder(court, caseNo, itemNo, firstSeenAt, lastSeenAt);
	}

	public Long getId() {
		return id;
	}

	public String getCourt() {
		return court;
	}

	public String getCaseNo() {
		return caseNo;
	}

	public String getItemNo() {
		return itemNo;
	}

	public String getUsageType() {
		return usageType;
	}

	public Long getAppraisalPrice() {
		return appraisalPrice;
	}

	public Long getMinBidPrice() {
		return minBidPrice;
	}

	public Integer getFailedBidCount() {
		return failedBidCount;
	}

	public String getStatus() {
		return status;
	}

	public Instant getFirstSeenAt() {
		return firstSeenAt;
	}

	public Instant getLastSeenAt() {
		return lastSeenAt;
	}

	public Integer getMinArea() {
		return minArea;
	}

	public Integer getMaxArea() {
		return maxArea;
	}

	public String getBuildingDescription() {
		return buildingDescription;
	}

	public String getNote() {
		return note;
	}

	public String getDuplicateCaseNo() {
		return duplicateCaseNo;
	}

	public String getMergedCaseNo() {
		return mergedCaseNo;
	}

	public Location getLocation() {
		return location;
	}

	public AuctionSchedule getSchedule() {
		return schedule;
	}

	public PriceRounds getPriceRounds() {
		return priceRounds;
	}

	public UsageCodes getUsageCodes() {
		return usageCodes;
	}

	public CourtContact getCourtContact() {
		return courtContact;
	}

	public SourceIds getSourceIds() {
		return sourceIds;
	}

	public PhotoInfo getPhotoInfo() {
		return photoInfo;
	}

	/** 편의 접근자: 매각기일. 일정이 없으면 null. */
	public LocalDate auctionDate() {
		return schedule == null ? null : schedule.auctionDate();
	}

	public static final class Builder {

		private final String court;
		private final String caseNo;
		private final String itemNo;
		private final Instant firstSeenAt;
		private final Instant lastSeenAt;
		private String usageType;
		private Long appraisalPrice;
		private Long minBidPrice;
		private Integer failedBidCount;
		private String status;
		private Integer minArea;
		private Integer maxArea;
		private String buildingDescription;
		private String note;
		private String duplicateCaseNo;
		private String mergedCaseNo;
		private Location location;
		private AuctionSchedule schedule;
		private PriceRounds priceRounds;
		private UsageCodes usageCodes;
		private CourtContact courtContact;
		private SourceIds sourceIds;
		private PhotoInfo photoInfo;

		private Builder(String court, String caseNo, String itemNo, Instant firstSeenAt, Instant lastSeenAt) {
			this.court = court;
			this.caseNo = caseNo;
			this.itemNo = itemNo;
			this.firstSeenAt = firstSeenAt;
			this.lastSeenAt = lastSeenAt;
		}

		public Builder usageType(String v) {
			this.usageType = v;
			return this;
		}

		public Builder appraisalPrice(Long v) {
			this.appraisalPrice = v;
			return this;
		}

		public Builder minBidPrice(Long v) {
			this.minBidPrice = v;
			return this;
		}

		public Builder failedBidCount(Integer v) {
			this.failedBidCount = v;
			return this;
		}

		public Builder status(String v) {
			this.status = v;
			return this;
		}

		public Builder minArea(Integer v) {
			this.minArea = v;
			return this;
		}

		public Builder maxArea(Integer v) {
			this.maxArea = v;
			return this;
		}

		public Builder buildingDescription(String v) {
			this.buildingDescription = v;
			return this;
		}

		public Builder note(String v) {
			this.note = v;
			return this;
		}

		public Builder duplicateCaseNo(String v) {
			this.duplicateCaseNo = v;
			return this;
		}

		public Builder mergedCaseNo(String v) {
			this.mergedCaseNo = v;
			return this;
		}

		public Builder location(Location v) {
			this.location = v;
			return this;
		}

		public Builder schedule(AuctionSchedule v) {
			this.schedule = v;
			return this;
		}

		public Builder priceRounds(PriceRounds v) {
			this.priceRounds = v;
			return this;
		}

		public Builder usageCodes(UsageCodes v) {
			this.usageCodes = v;
			return this;
		}

		public Builder courtContact(CourtContact v) {
			this.courtContact = v;
			return this;
		}

		public Builder sourceIds(SourceIds v) {
			this.sourceIds = v;
			return this;
		}

		public Builder photoInfo(PhotoInfo v) {
			this.photoInfo = v;
			return this;
		}

		public Item build() {
			return new Item(this);
		}

	}

}
