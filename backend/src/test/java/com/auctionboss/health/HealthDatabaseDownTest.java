package com.auctionboss.health;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.testcontainers.mysql.MySQLContainer;

/**
 * 스펙 "데이터베이스 중단": 이 테스트만의 전용 MySQL 컨테이너를 띄우고 멈춘 뒤 503을 확인한다.
 * 공용 컨테이너를 멈추면 다른 테스트가 깨지므로 독립 컨텍스트를 쓴다.
 */
@SpringBootTest
@ActiveProfiles("test")
@AutoConfigureMockMvc
class HealthDatabaseDownTest {

	private static final MySQLContainer DEDICATED = new MySQLContainer("mysql:8.4");

	static {
		DEDICATED.start();
	}

	@DynamicPropertySource
	static void datasource(DynamicPropertyRegistry registry) {
		registry.add("spring.datasource.url", DEDICATED::getJdbcUrl);
		registry.add("spring.datasource.username", DEDICATED::getUsername);
		registry.add("spring.datasource.password", DEDICATED::getPassword);
		// 중단 후 연결 획득이 오래 매달리지 않게 짧게 둔다.
		registry.add("spring.datasource.hikari.connection-timeout", () -> "2000");
	}

	@Autowired
	MockMvc mvc;

	@AfterAll
	static void stopContainer() {
		DEDICATED.stop();
	}

	@Test
	void databaseDownReturns503() throws Exception {
		mvc.perform(get("/api/health")).andExpect(status().isOk());

		DEDICATED.stop();

		mvc.perform(get("/api/health")).andExpect(status().isServiceUnavailable())
				.andExpect(jsonPath("$.status").value("error"))
				.andExpect(jsonPath("$.database").value("disconnected")).andExpect(jsonPath("$.error").isString())
				.andExpect(jsonPath("$.timestamp").isString()).andExpect(jsonPath("$.uptime").doesNotExist());
	}

}
