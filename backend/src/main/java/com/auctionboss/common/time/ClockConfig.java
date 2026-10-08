package com.auctionboss.common.time;

import java.time.Clock;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/** "지금"이 필요한 곳(지난 기일 제외, 재분석 간격)은 이 Clock을 주입받는다. 테스트는 고정 Clock으로 바꾼다. */
@Configuration(proxyBeanMethods = false)
public class ClockConfig {

	@Bean
	Clock clock() {
		return Clock.systemUTC();
	}

}
