package com.auctionboss.migration;

import java.nio.file.Path;
import java.sql.Connection;
import java.sql.SQLException;

/**
 * 가져오기 단계 사이에 끼어드는 시험용 이음매(운영에는 이 빈이 없다). 해시 대조가 정말로 대상의 실제 값을 보는지, 사진 대조와 되돌리기가
 * 동작하는지 테스트가 일부러 값을 바꿔 확인할 때 쓴다.
 */
public interface ImportHook {

	/** SQL을 적재한 직후, 해시를 대조하기 전(같은 트랜잭션 연결). */
	default void afterLoad(Connection connection) throws SQLException {
	}

	/** 사진을 복사한 직후, 대조하기 전. {@code photosRoot}는 복사 대상 디렉터리다. */
	default void afterPhotosCopied(Path photosRoot) {
	}

}
