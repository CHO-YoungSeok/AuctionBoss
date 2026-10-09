package com.auctionboss.collect.run;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.SmartInitializingSingleton;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

/** 기동 시 두 워커의 주기 실행과 외부 요청 허용 설정을 로그로 남긴다(꺼져 있어도 남는다: 스펙 "기본 설정으로 기동"). */
@Component
class SchedulerStatusLogger implements SmartInitializingSingleton {

	private static final Logger log = LoggerFactory.getLogger(SchedulerStatusLogger.class);

	private final boolean collectorEnabled;

	private final boolean photosEnabled;

	private final boolean externalRequestsAllowed;

	SchedulerStatusLogger(@Value("${auctionboss.collector.enabled:false}") boolean collectorEnabled,
			@Value("${auctionboss.photos.enabled:false}") boolean photosEnabled,
			@Value("${auctionboss.source.external-requests-allowed:false}") boolean externalRequestsAllowed) {
		this.collectorEnabled = collectorEnabled;
		this.photosEnabled = photosEnabled;
		this.externalRequestsAllowed = externalRequestsAllowed;
	}

	@Override
	public void afterSingletonsInstantiated() {
		log.info("[scheduler] 수집 워커 {}, 사진 워커 {}, 외부 요청 허용 {}", collectorEnabled ? "켜짐" : "꺼짐",
				photosEnabled ? "켜짐" : "꺼짐", externalRequestsAllowed ? "켜짐" : "꺼짐");
	}

}
