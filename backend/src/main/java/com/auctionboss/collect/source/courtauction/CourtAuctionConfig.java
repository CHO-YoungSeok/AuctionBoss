package com.auctionboss.collect.source.courtauction;

import com.auctionboss.collect.source.AuctionSource;
import com.auctionboss.collect.source.Sleeper;
import com.auctionboss.collect.source.ThreadSleeper;
import java.time.Clock;

import org.springframework.beans.factory.config.ConfigurableBeanFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Scope;

/**
 * 소스 어댑터 빈 생성(어댑터 패키지 밖 코드는 이 패키지에 의존하지 않고 {@link AuctionSource}만 본다). 설정은
 * {@code auctionboss.source.*}로만 바꾼다.
 *
 * <p>
 * {@code external-requests-allowed}의 기본값은 {@code false}다: 루프백이 아닌 주소로는 소켓을 열기 전에 거절한다(design D4). 어댑터는 사진
 * 세션을 인스턴스 안에 들고 있으므로 회차마다 새 인스턴스를 쓰도록 prototype 범위다.
 */
@Configuration(proxyBeanMethods = false)
public class CourtAuctionConfig {

	@Bean
	@ConditionalOnMissingBean(Sleeper.class)
	Sleeper sleeper() {
		return new ThreadSleeper();
	}

	@Bean
	@Scope(ConfigurableBeanFactory.SCOPE_PROTOTYPE)
	AuctionSource auctionSource(
			@Value("${auctionboss.source.base-url:" + CourtAuctionOptions.BASE_URL + "}") String baseUrl,
			@Value("${auctionboss.source.external-requests-allowed:false}") boolean externalRequestsAllowed,
			@Value("${auctionboss.source.page-size:" + CourtAuctionOptions.MAX_PAGE_SIZE + "}") int pageSize,
			@Value("${auctionboss.source.page-delay-ms:" + CourtAuctionOptions.DEFAULT_PAGE_DELAY_MS + "}") long pageDelayMs,
			@Value("${auctionboss.source.bid-window-days:" + CourtAuctionOptions.DEFAULT_BID_WINDOW_DAYS
					+ "}") int bidWindowDays,
			@Value("${auctionboss.source.max-pages:" + CourtAuctionOptions.DEFAULT_MAX_PAGES + "}") int maxPages,
			Sleeper sleeper, Clock clock) {
		CourtAuctionOptions options = new CourtAuctionOptions(baseUrl, pageSize, pageDelayMs, bidWindowDays, maxPages);
		return new CourtAuctionAdapter(options, externalRequestsAllowed, sleeper, clock);
	}

}
