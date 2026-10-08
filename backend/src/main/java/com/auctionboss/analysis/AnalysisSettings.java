package com.auctionboss.analysis;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/**
 * 재분석 설정. 원본처럼 {@code config/collector.json}의 {@code analysis.reanalysisCooldownHours}를
 * 단일 원천으로 읽는다(요청 파라미터가 아니다). 파일은 호출마다 읽어 설정 변경이 재기동 없이 반영된다
 * (원본 {@code loadCollectorConfig()}도 요청마다 읽는다).
 *
 * <p>
 * 파일 경로는 {@code auctionboss.config-path}. 비우면 실행 위치 기준 {@code ../config/collector.json},
 * {@code config/collector.json} 중 존재하는 것. 테스트용으로 {@code auctionboss.analysis.reanalysis-cooldown-hours}를
 * 주면 파일을 읽지 않고 그 값을 쓴다.
 */
@Component
public class AnalysisSettings {

	private static final JsonMapper MAPPER = JsonMapper.builder().build();

	private final String configPath;

	private final Integer cooldownOverride;

	public AnalysisSettings(@Value("${auctionboss.config-path:}") String configPath,
			@Value("${auctionboss.analysis.reanalysis-cooldown-hours:#{null}}") Integer cooldownOverride) {
		this.configPath = configPath;
		this.cooldownOverride = cooldownOverride;
	}

	/** 값을 직접 정하는 생성자(저장소 테스트용). */
	public static AnalysisSettings ofCooldownHours(int hours) {
		return new AnalysisSettings("", hours);
	}

	/** 재분석 최소 간격(시간). 0 이상의 정수. */
	public int reanalysisCooldownHours() {
		if (cooldownOverride != null) {
			return cooldownOverride;
		}
		Path path = resolvePath();
		JsonNode node;
		try {
			node = MAPPER.readTree(Files.readString(path)).path("analysis").path("reanalysisCooldownHours");
		}
		catch (IOException | RuntimeException e) {
			throw new IllegalStateException("재분석 설정 파일을 읽지 못했습니다: " + path, e);
		}
		if (!node.isIntegralNumber() || node.asInt() < 0) {
			throw new IllegalStateException(
					"analysis.reanalysisCooldownHours는 0 이상의 정수여야 합니다: " + path);
		}
		return node.asInt();
	}

	private Path resolvePath() {
		if (!configPath.isBlank()) {
			return Path.of(configPath);
		}
		for (String candidate : new String[] { "../config/collector.json", "config/collector.json" }) {
			Path path = Path.of(candidate);
			if (Files.isRegularFile(path)) {
				return path;
			}
		}
		throw new IllegalStateException(
				"config/collector.json을 찾지 못했습니다. auctionboss.config-path로 경로를 지정하세요.");
	}

}
