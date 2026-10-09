package com.auctionboss;

import java.util.TimeZone;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.context.ConfigurableApplicationContext;

@SpringBootApplication
public class BackendApplication {

	/** 1회 실행 모드를 켜는 속성(값은 collector 또는 photos). 없으면 기본 서버 모드다. */
	public static final String RUN_ONCE_PROPERTY = "auctionboss.run-once";

	public static void main(String[] args) {
		// 시각은 항상 UTC로 저장한다. JVM 기본 시간대와 무관하게 동작하도록 가장 먼저 고정한다.
		TimeZone.setDefault(TimeZone.getTimeZone("UTC"));
		Integer exitCode = start(args);
		if (exitCode != null) {
			System.exit(exitCode);
		}
	}

	/**
	 * 애플리케이션을 시작한다. 서버 모드면 컨텍스트를 살려 둔 채 null을 돌려준다. 1회 실행 모드({@value #RUN_ONCE_PROPERTY})면 웹 서버
	 * 없이 회차 하나를 실행한 뒤 컨텍스트를 닫고 종료 코드(성공 0, 그 밖 1)를 돌려준다.
	 */
	public static Integer start(String... args) {
		ConfigurableApplicationContext context = SpringApplication.run(BackendApplication.class, args);
		if (context.getEnvironment().containsProperty(RUN_ONCE_PROPERTY)) {
			return SpringApplication.exit(context);
		}
		return null;
	}

}
