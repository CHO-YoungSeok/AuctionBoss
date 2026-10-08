package com.auctionboss.collect.source;

/** 실제로 현재 스레드를 재우는 기본 구현. */
public final class ThreadSleeper implements Sleeper {

	@Override
	public void sleep(long millis) {
		try {
			Thread.sleep(millis);
		}
		catch (InterruptedException e) {
			Thread.currentThread().interrupt();
			throw new IllegalStateException("대기 중 인터럽트되었습니다", e);
		}
	}

}
