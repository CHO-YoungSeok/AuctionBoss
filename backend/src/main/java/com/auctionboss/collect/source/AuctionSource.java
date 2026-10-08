package com.auctionboss.collect.source;

/**
 * 수집 소스 어댑터 계약. 특정 소스의 고유 형식이 이 패키지에 들어오면 안 된다. 수집·사진 워커는 이 인터페이스만 본다.
 *
 * <p>
 * 호출은 동기이고 동시에 둘 이상 부르지 않는다(회차는 워커 전용 스레드 하나). 실패는 빈 결과가 아니라 {@link SourceException}으로
 * 알린다: "결과 0건"과 "실패"를 호출자가 구분할 수 있어야 한다. 차단은 {@link SourceBlockedException}.
 */
public interface AuctionSource {

	/** 수집 범위의 "진행 중" 물건을 전부 조회한다. 필수 필드(법원·사건번호·물건번호)가 없는 항목은 결과에서 뺀다. */
	FetchActiveItemsResult fetchActiveItems(CollectScope scope);

	/** 한 물건의 사진을 조회한다. 사진이 없으면 빈 결과. */
	FetchItemPhotosResult fetchItemPhotos(PhotoLookupRef ref);

}
