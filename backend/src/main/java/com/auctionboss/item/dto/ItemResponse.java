package com.auctionboss.item.dto;

import java.time.Instant;
import java.time.LocalDate;

import com.auctionboss.item.AuctionSchedule;
import com.auctionboss.item.CourtContact;
import com.auctionboss.item.Item;
import com.auctionboss.item.Location;
import com.auctionboss.item.PhotoInfo;
import com.auctionboss.item.PriceRounds;
import com.auctionboss.item.SourceIds;
import com.auctionboss.item.UsageCodes;
import com.fasterxml.jackson.annotation.JsonInclude;

/**
 * 목록·상세 응답의 물건 한 건. 필드 이름과 순서는 원본 {@code AuctionItem}(toAuctionItem)과 같다.
 * 값이 없으면 null로 내보내지만, 원본이 값 없음을 undefined로 두어 JSON에서 빠지던
 * {@code photoStatus}, {@code photoCount}는 null이면 생략한다.
 */
public record ItemResponse(Long id, String court, String caseNo, String itemNo, String address, String usageType,
		Long appraisalPrice, Long minBidPrice, LocalDate auctionDate, Integer failedBidCount, String status,
		Instant firstSeenAt, Instant lastSeenAt, Instant lastChangedAt, boolean bookmarked, Integer minArea,
		Integer maxArea, String buildingDescription, Long minBidPriceRound1, Long minBidPriceRound2,
		Long minBidPriceRound3, Long minBidPriceRound4, Integer minBidPriceRateRound1, Integer minBidPriceRateRound2,
		String usageCodeLarge, String usageCodeMedium, String usageCodeSmall, String sido, String sigungu,
		String dong, String lotNumber, String buildingName, String buildingUnit, String coordinateX,
		String coordinateY, String coordinateLevel, String auctionTime, String auctionPlace,
		LocalDate auctionDecisionDate, Integer auctionRound, String note, String duplicateCaseNo,
		String mergedCaseNo, String courtDepartment, String courtPhone, String statusCode, String itemStatusCode,
		String internalCaseNo, String courtCode, @JsonInclude(JsonInclude.Include.NON_NULL) String photoStatus,
		@JsonInclude(JsonInclude.Include.NON_NULL) Integer photoCount, Instant photoCollectedAt) {

	private static final Location NO_LOCATION = new Location(null, null, null, null, null, null, null, null, null,
			null);

	private static final AuctionSchedule NO_SCHEDULE = new AuctionSchedule(null, null, null, null, null);

	private static final PriceRounds NO_ROUNDS = new PriceRounds(null, null, null, null, null, null);

	private static final UsageCodes NO_CODES = new UsageCodes(null, null, null);

	private static final CourtContact NO_CONTACT = new CourtContact(null, null);

	private static final SourceIds NO_SOURCE = new SourceIds(null, null, null, null);

	private static final PhotoInfo NO_PHOTO = new PhotoInfo(null, null, null);

	/** 값 객체 컬럼이 전부 NULL이면 Hibernate가 값 객체를 null로 읽으므로 빈 값 객체로 바꿔 둔다. */
	public static ItemResponse of(Item item, Instant lastChangedAt, boolean bookmarked) {
		Location loc = orElse(item.getLocation(), NO_LOCATION);
		AuctionSchedule sch = orElse(item.getSchedule(), NO_SCHEDULE);
		PriceRounds pr = orElse(item.getPriceRounds(), NO_ROUNDS);
		UsageCodes uc = orElse(item.getUsageCodes(), NO_CODES);
		CourtContact cc = orElse(item.getCourtContact(), NO_CONTACT);
		SourceIds src = orElse(item.getSourceIds(), NO_SOURCE);
		PhotoInfo photo = orElse(item.getPhotoInfo(), NO_PHOTO);
		return new ItemResponse(item.getId(), item.getCourt(), item.getCaseNo(), item.getItemNo(), loc.address(),
				item.getUsageType(), item.getAppraisalPrice(), item.getMinBidPrice(), sch.auctionDate(),
				item.getFailedBidCount(), item.getStatus(), item.getFirstSeenAt(), item.getLastSeenAt(),
				lastChangedAt, bookmarked, item.getMinArea(), item.getMaxArea(), item.getBuildingDescription(),
				pr.minBidPriceRound1(), pr.minBidPriceRound2(), pr.minBidPriceRound3(), pr.minBidPriceRound4(),
				pr.minBidPriceRateRound1(), pr.minBidPriceRateRound2(), uc.usageCodeLarge(), uc.usageCodeMedium(),
				uc.usageCodeSmall(), loc.sido(), loc.sigungu(), loc.dong(), loc.lotNumber(), loc.buildingName(),
				loc.buildingUnit(), loc.coordinateX(), loc.coordinateY(), loc.coordinateLevel(), sch.auctionTime(),
				sch.auctionPlace(), sch.auctionDecisionDate(), sch.auctionRound(), item.getNote(),
				item.getDuplicateCaseNo(), item.getMergedCaseNo(), cc.courtDepartment(), cc.courtPhone(),
				src.statusCode(), src.itemStatusCode(), src.internalCaseNo(), src.courtCode(),
				photo.photoStatus() == null ? null : photo.photoStatus().dbValue(), photo.photoCount(),
				photo.photoCollectedAt());
	}

	private static <T> T orElse(T value, T fallback) {
		return value != null ? value : fallback;
	}

}
