package com.auctionboss.support;

import java.time.Duration;
import java.util.function.BooleanSupplier;

/** 조건이 참이 될 때까지 짧게 기다리는 도우미. 시간 의존 테스트가 고정 sleep에 기대지 않게 한다(상한만 두고, 정상 경로는 곧바로 끝난다). */
public final class Eventually {

	private Eventually() {
	}

	public static boolean until(Duration timeout, BooleanSupplier condition) {
		long deadline = System.nanoTime() + timeout.toNanos();
		while (System.nanoTime() < deadline) {
			if (condition.getAsBoolean()) {
				return true;
			}
			try {
				Thread.sleep(10);
			}
			catch (InterruptedException e) {
				Thread.currentThread().interrupt();
				return false;
			}
		}
		return condition.getAsBoolean();
	}

}
