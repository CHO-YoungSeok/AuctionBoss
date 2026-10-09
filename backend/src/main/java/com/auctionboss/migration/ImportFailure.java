package com.auctionboss.migration;

/** 가져오기가 중단되는 이유. 메시지에는 값이 없고 테이블·id·컬럼 이름과 건수만 들어간다(D14). */
final class ImportFailure extends RuntimeException {

	ImportFailure(String message) {
		super(message);
	}

}
