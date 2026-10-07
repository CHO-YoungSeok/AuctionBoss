package com.auctionboss.common.seed;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.context.ApplicationContext;

import com.auctionboss.support.AbstractMySqlTest;

/** 스펙 "운영 환경 기동": seed 프로필이 없으면 로더 빈이 없고 물건은 0건이다. */
class SeedDisabledTest extends AbstractMySqlTest {

	@Autowired
	private ApplicationContext context;

	@Test
	void 기본_test_프로필에는_로더가_없고_items는_0건이다() {
		assertThat(context.getBeanNamesForType(SeedLoader.class)).isEmpty();
		assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM items", Long.class)).isZero();
	}

}
