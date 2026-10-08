package com.auctionboss.worker;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/**
 * 워커 설정. 원본처럼 {@code config/collector.json}의 {@code observability.maxRunsPerWorker}를 단일 원천으로 읽는다.
 * {@code AnalysisSettings}와 같이 호출마다 파일을 읽어 설정 변경이 재기동 없이 반영된다.
 *
 * <p>
 * 파일 경로는 {@code auctionboss.config-path}. 비우면 실행 위치 기준 {@code ../config/collector.json},
 * {@code config/collector.json} 중 존재하는 것. 테스트용으로 {@code auctionboss.worker.max-runs-per-worker}를 주면 파일을
 * 읽지 않고 그 값을 쓴다.
 */
@Component
public class WorkerSettings {

	private static final JsonMapper MAPPER = JsonMapper.builder().build();

	private final String configPath;

	private final Integer maxRunsOverride;

	/** 테스트용 덮어쓰기: 워커별 기대 주기(ms)와 미실행 배수. 비어 있으면 설정 파일을 읽는다. */
	@Value("${auctionboss.worker.collector-interval-ms:#{null}}")
	private Integer collectorIntervalOverride;

	@Value("${auctionboss.worker.analyzer-interval-ms:#{null}}")
	private Integer analyzerIntervalOverride;

	@Value("${auctionboss.worker.photos-interval-ms:#{null}}")
	private Integer photosIntervalOverride;

	@Value("${auctionboss.worker.stale-after-intervals:#{null}}")
	private Integer staleAfterOverride;

	public WorkerSettings(@Value("${auctionboss.config-path:}") String configPath,
			@Value("${auctionboss.worker.max-runs-per-worker:#{null}}") Integer maxRunsOverride) {
		this.configPath = configPath;
		this.maxRunsOverride = maxRunsOverride;
	}

	/** 워커별 회차 최대 보관 건수. 1 이상의 정수. */
	public int maxRunsPerWorker() {
		if (maxRunsOverride != null) {
			if (maxRunsOverride < 1) {
				throw new IllegalStateException("auctionboss.worker.max-runs-per-worker는 1 이상의 정수여야 합니다");
			}
			return maxRunsOverride;
		}
		Path path = resolvePath();
		JsonNode node;
		try {
			node = MAPPER.readTree(Files.readString(path)).path("observability").path("maxRunsPerWorker");
		}
		catch (IOException | RuntimeException e) {
			throw new IllegalStateException("워커 설정 파일을 읽지 못했습니다: " + path, e);
		}
		if (!node.isIntegralNumber() || !node.canConvertToInt() || node.asInt() < 1) {
			throw new IllegalStateException("observability.maxRunsPerWorker는 1 이상의 정수여야 합니다: " + path);
		}
		return node.asInt();
	}

	/**
	 * 워커별 기대 주기(ms). 원본 {@code getWorkerStatus}와 같다: 수집은 {@code intervalMs}, 분석은
	 * {@code analysis.intervalMs}, 사진은 {@code photos.intervalMs}. 다른 워커의 주기로 판정하지 않는다.
	 */
	public long intervalMs(String worker) {
		Integer override = switch (worker) {
			case "collector" -> collectorIntervalOverride;
			case "analyzer" -> analyzerIntervalOverride;
			case "photos" -> photosIntervalOverride;
			default -> throw new IllegalArgumentException("알 수 없는 워커: " + worker);
		};
		if (override != null) {
			return positive(override, "기대 주기 덮어쓰기");
		}
		String pointer = switch (worker) {
			case "collector" -> "/intervalMs";
			case "analyzer" -> "/analysis/intervalMs";
			default -> "/photos/intervalMs";
		};
		return positive(readNode(pointer), pointer.substring(1).replace('/', '.'));
	}

	/** 미실행 판정 배수({@code observability.staleAfterIntervals}). 1 이상의 정수. */
	public int staleAfterIntervals() {
		if (staleAfterOverride != null) {
			return (int) positive(staleAfterOverride, "auctionboss.worker.stale-after-intervals");
		}
		return (int) positive(readNode("/observability/staleAfterIntervals"), "observability.staleAfterIntervals");
	}

	private JsonNode readNode(String pointer) {
		Path path = resolvePath();
		try {
			return MAPPER.readTree(Files.readString(path)).at(pointer);
		}
		catch (IOException | RuntimeException e) {
			throw new IllegalStateException("워커 설정 파일을 읽지 못했습니다: " + path, e);
		}
	}

	private static long positive(JsonNode node, String name) {
		if (!node.isIntegralNumber() || !node.canConvertToInt() || node.asInt() < 1) {
			throw new IllegalStateException(name + "은(는) 1 이상의 정수여야 합니다");
		}
		return node.asInt();
	}

	private static long positive(int value, String name) {
		if (value < 1) {
			throw new IllegalStateException(name + "은(는) 1 이상의 정수여야 합니다");
		}
		return value;
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
