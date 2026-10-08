package com.auctionboss.common.time;

import java.time.Clock;
import java.time.Instant;
import java.time.temporal.ChronoUnit;

import org.springframework.stereotype.Component;

/**
 * 쓰기에 쓰는 "지금". 주입된 {@link Clock}에서 읽어 밀리초로 자른다. DATETIME(3)은 마이크로초를 반올림·절삭하므로
 * 자르지 않으면 응답 값과 저장 값이 달라진다. 한 요청에서 한 번만 호출해 같은 값을 저장과 응답에 쓴다.
 */
@Component
public class ServerClock {

	private final Clock clock;

	public ServerClock(Clock clock) {
		this.clock = clock;
	}

	public Instant now() {
		return clock.instant().truncatedTo(ChronoUnit.MILLIS);
	}

}
