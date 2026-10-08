package com.auctionboss.support;

import java.time.Clock;
import java.time.Instant;

import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Primary;

/** 운영 Clock 빈보다 우선하는 테스트용 가변 Clock. 기본값은 2026-10-08T12:00:00Z. */
@TestConfiguration(proxyBeanMethods = false)
public class FixedClockConfig {

	public static final Instant DEFAULT_NOW = Instant.parse("2026-10-08T12:00:00Z");

	@Bean
	@Primary
	MutableClock testClock() {
		return new MutableClock(DEFAULT_NOW);
	}

}
