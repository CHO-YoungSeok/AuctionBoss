package com.auctionboss.health;

import java.lang.management.ManagementFactory;
import java.time.Clock;
import java.util.LinkedHashMap;
import java.util.Map;

import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.beans.factory.annotation.Autowired;
import javax.sql.DataSource;

/**
 * {@code GET /api/health}. 원본 라우트와 같은 형태다: 정상 200 {@code {status, database, timestamp, uptime}},
 * DB 실패 503 {@code {status, database, error, timestamp}}. DB 확인은 짧은 타임아웃의 {@code SELECT 1}이다.
 */
@RestController
public class HealthController {

	private static final int QUERY_TIMEOUT_SECONDS = 2;

	private final JdbcTemplate jdbc;

	private final Clock clock;

	@Autowired
	public HealthController(DataSource dataSource, Clock clock) {
		this.jdbc = new JdbcTemplate(dataSource);
		this.jdbc.setQueryTimeout(QUERY_TIMEOUT_SECONDS);
		this.clock = clock;
	}

	@GetMapping("/api/health")
	ResponseEntity<Map<String, Object>> health() {
		Map<String, Object> body = new LinkedHashMap<>();
		try {
			jdbc.queryForObject("SELECT 1", Integer.class);
		}
		catch (RuntimeException e) {
			body.put("status", "error");
			body.put("database", "disconnected");
			body.put("error", e.getClass().getSimpleName());
			body.put("timestamp", clock.instant());
			return ResponseEntity.status(HttpStatus.SERVICE_UNAVAILABLE).body(body);
		}
		body.put("status", "ok");
		body.put("database", "connected");
		body.put("timestamp", clock.instant());
		// 원본 process.uptime(): 초 단위, 소수 포함.
		body.put("uptime", ManagementFactory.getRuntimeMXBean().getUptime() / 1000.0);
		return ResponseEntity.ok(body);
	}

}
