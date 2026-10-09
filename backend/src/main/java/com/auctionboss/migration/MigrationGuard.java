package com.auctionboss.migration;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.SmartInitializingSingleton;
import org.springframework.boot.autoconfigure.condition.ConditionalOnExpression;
import org.springframework.context.annotation.Profile;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

/**
 * 이전 완료 표식이 없으면 운영 프로필의 수집·사진 스케줄러 기동을 거부한다(design D7). 이전 전에 운영 구성을 띄워도 빈 데이터베이스로 실제
 * 소스에 요청하지 않게 한다.
 *
 * <p>
 * 조건: {@code prod} 프로필이고, 수집 또는 사진 주기 실행이 켜져 있고, 1회 실행 모드가 아닐 때만 빈이 있다. {@code local}·{@code test}·시드
 * 프로필과 스케줄러가 꺼진 실행(기본)에는 이 빈이 없어 아무 검사도 하지 않는다. 모든 싱글톤이 만들어진 뒤(수집 스케줄러는
 * {@code SmartLifecycle}이라 그 뒤에 시작한다) 검사하므로 실패하면 틱이 하나도 등록되지 않는다.
 */
@Component
@Profile("prod")
@ConditionalOnExpression("(${auctionboss.collector.enabled:false} or ${auctionboss.photos.enabled:false}) and '${auctionboss.run-once:}' == ''")
class MigrationGuard implements SmartInitializingSingleton {

	private static final Logger log = LoggerFactory.getLogger(MigrationGuard.class);

	private final JdbcTemplate jdbc;

	MigrationGuard(JdbcTemplate jdbc) {
		this.jdbc = jdbc;
	}

	@Override
	public void afterSingletonsInstantiated() {
		if (MigrationMarker.exists(jdbc)) {
			log.info("[migration] 이전 완료 표식을 확인했습니다");
			return;
		}
		String message = "이전 완료 표식(collector_state 키 " + MigrationMarker.KEY + ")이 없어 수집·사진 스케줄러를 기동하지 않습니다. "
				+ "운영 데이터를 이전한 뒤(auctionboss.run-once=import) 다시 띄우세요 - docs/REFERENCE.md 운영 전환 런북";
		log.error("[migration] {}", message);
		throw new IllegalStateException(message);
	}

}
