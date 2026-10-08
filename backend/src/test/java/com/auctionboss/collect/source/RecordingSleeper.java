package com.auctionboss.collect.source;

import java.util.ArrayList;
import java.util.List;
import java.util.function.IntSupplier;

/** 실제로 자지 않고 호출된 대기를 기록한다. {@code afterRequests}는 그 시점까지 서버가 받은 요청 수다. */
public final class RecordingSleeper implements Sleeper {

	public record Sleep(long ms, int afterRequests) {
	}

	private final IntSupplier requestsSoFar;

	private final List<Sleep> sleeps = new ArrayList<>();

	public RecordingSleeper(IntSupplier requestsSoFar) {
		this.requestsSoFar = requestsSoFar;
	}

	@Override
	public void sleep(long millis) {
		sleeps.add(new Sleep(millis, requestsSoFar.getAsInt()));
	}

	public List<Sleep> sleeps() {
		return List.copyOf(sleeps);
	}

}
