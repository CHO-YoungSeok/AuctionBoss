package com.auctionboss.collect.source;

/** 요청 사이 대기. 테스트는 실제로 자지 않고 호출된 시간을 기록하는 구현을 주입한다. */
@FunctionalInterface
public interface Sleeper {

	void sleep(long millis);

}
