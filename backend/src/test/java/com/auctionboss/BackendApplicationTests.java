package com.auctionboss;

import org.junit.jupiter.api.Test;

import com.auctionboss.support.AbstractMySqlTest;

/** Flyway + ddl-auto=validate로 컨텍스트가 뜨는지(엔티티와 V1 스키마 일치) 확인한다. */
class BackendApplicationTests extends AbstractMySqlTest {

	@Test
	void contextLoads() {
	}

}
