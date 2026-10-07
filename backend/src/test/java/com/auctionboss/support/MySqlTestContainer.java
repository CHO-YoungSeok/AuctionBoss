package com.auctionboss.support;

import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.boot.testcontainers.service.connection.ServiceConnection;
import org.springframework.context.annotation.Bean;
import org.testcontainers.mysql.MySQLContainer;

/**
 * 테스트 전체가 공유하는 MySQL 컨테이너. JVM당 한 번만 띄우고(싱글턴) 종료는 Ryuk가 맡는다.
 * 스프링 컨텍스트가 여러 개여도 같은 컨테이너를 쓴다.
 */
@TestConfiguration(proxyBeanMethods = false)
public class MySqlTestContainer {

	public static final MySQLContainer MYSQL = new MySQLContainer("mysql:8.4");

	static {
		MYSQL.start();
	}

	@Bean
	@ServiceConnection
	MySQLContainer mysqlContainer() {
		return MYSQL;
	}

}
