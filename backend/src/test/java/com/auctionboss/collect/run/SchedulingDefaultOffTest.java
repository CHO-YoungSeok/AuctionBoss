package com.auctionboss.collect.run;

import static org.assertj.core.api.Assertions.assertThat;

import java.net.InetAddress;
import java.net.URI;

import com.auctionboss.support.AbstractMySqlTest;
import com.auctionboss.support.FakeSourceConfig;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.context.ApplicationContext;
import org.springframework.context.annotation.Import;
import org.springframework.core.env.Environment;
import org.springframework.scheduling.concurrent.ThreadPoolTaskScheduler;
import org.springframework.test.context.TestPropertySource;

/**
 * 5.4(기본 꺼짐)와 design D4 테스트 프로필 확인. 수집 주기를 100ms로 둔 설정 파일을 쓰므로 켜져 있었다면 짧은 대기 안에 회차가 쌓인다.
 * 켜는 설정은 어디에도 주지 않는다.
 */
@Import(FakeSourceConfig.class)
@TestPropertySource(properties = "auctionboss.config-path=src/test/resources/config/collector-fast.json")
class SchedulingDefaultOffTest extends AbstractMySqlTest {

	@Autowired
	ApplicationContext context;

	@Autowired
	Environment env;

	@Test
	void 기본_설정_컨텍스트에는_스케줄러와_틱_빈이_없다() {
		assertThat(context.getBeanNamesForType(WorkerSchedule.class)).isEmpty();
		assertThat(context.getBeanNamesForType(WorkerScheduler.class)).isEmpty();
		assertThat(context.getBeanNamesForType(ThreadPoolTaskScheduler.class)).isEmpty();
		assertThat(context.getBeanNamesForType(SchedulingConfig.class)).isEmpty();
	}

	@Test
	void 주기보다_오래_기다려도_회차가_0건이다() throws Exception {
		Thread.sleep(600); // 설정 주기(100ms)의 여섯 배
		assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM worker_runs", Integer.class)).isZero();
	}

	@Test
	void 테스트_프로필의_소스_주소는_루프백이고_외부_요청_허용과_주기_실행은_꺼져_있다() throws Exception {
		String baseUrl = env.getProperty("auctionboss.source.base-url");
		assertThat(baseUrl).isNotNull();
		String host = URI.create(baseUrl).getHost();
		assertThat(InetAddress.getByName(host).isLoopbackAddress()).as("숫자 주소라 이름 조회가 없다: %s", host).isTrue();
		assertThat(env.getProperty("auctionboss.source.external-requests-allowed", Boolean.class, false)).isFalse();
		assertThat(env.getProperty("auctionboss.collector.enabled", Boolean.class, false)).isFalse();
		assertThat(env.getProperty("auctionboss.photos.enabled", Boolean.class, false)).isFalse();
	}

}
