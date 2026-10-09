package com.auctionboss.collect.photos;

/** 사진 수집 대기 물건. 소스에 조회할 식별자({@code internalCaseNo}, {@code courtCode})는 null이거나 빈 문자열일 수 있다. */
public record PendingPhoto(long id, String internalCaseNo, String courtCode) {

	/** 조회할 수 없는 물건(식별자가 없거나 빈 문자열): 요청도 실패 기록도 하지 않고 건너뛴다. */
	public boolean lookupable() {
		return internalCaseNo != null && !internalCaseNo.isEmpty() && courtCode != null && !courtCode.isEmpty();
	}

}
