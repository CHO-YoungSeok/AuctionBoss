package com.auctionboss.collect.run;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;

import com.auctionboss.collect.source.CourtRef;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/**
 * 수집·사진 워커 설정. {@code config/collector.json}을 단일 원천으로 호출마다 읽는다(설정 변경이 다음 회차에 반영된다). 검증 규칙은 TS
 * {@code config.ts}의 zod 스키마와 같다: 없거나 잘못된 값은 기본값으로 넘어가지 않고 {@link IllegalStateException}이다(메시지에 필드
 * 경로가 들어간다). 섹션별로 읽으므로 다른 섹션이 깨져 있어도 읽는 섹션만 검증한다(TS는 파일 전체를 한 번에 검증한다).
 *
 * <p>
 * 파일 경로는 {@code auctionboss.config-path}(비우면 {@code WorkerSettings}와 같은 후보). 덮어쓰기 속성은 1회 실행 모드와 개발 확인용이다:
 * {@code auctionboss.collector.max-courts-per-run}, {@code auctionboss.collector.max-requests-per-run},
 * {@code auctionboss.photos.max-items-per-run}, 사진 대상 물건 지정 {@code auctionboss.photos.only-item-id}. 차단 백오프 길이는 {@code auctionboss.collector.block-backoff-ms}(기본 1시간)다.
 */
@Component
public class CollectorSettings {

	/** TS {@code DEFAULT_BLOCK_BACKOFF_MS}. */
	public static final long DEFAULT_BLOCK_BACKOFF_MS = 60 * 60 * 1000L;

	/** 설정된 전체 법원과 회차 예산. 실제 회차 대상은 로테이션이 고른 일부다. */
	public record Scope(List<CourtRef> courts, long maxCourtsPerRun, long maxRequestsPerRun) {

		public Scope {
			courts = List.copyOf(courts);
		}

	}

	public record Photos(long intervalMs, long maxItemsPerRun, long requestDelayMs, long retryAfterHours) {
	}

	private static final JsonMapper MAPPER = JsonMapper.builder().build();

	/** JSON 숫자는 2^53까지만 정확하다(JS와 같은 상한). */
	private static final long MAX_SAFE = 9_007_199_254_740_991L;

	private final String configPath;

	private final Long maxCourtsOverride;

	private final Long maxRequestsOverride;

	private final Long photosMaxItemsOverride;

	private final long blockBackoffMs;

	private final Long photosOnlyItemId;

	public CollectorSettings(String configPath, Long maxCourtsOverride, Long maxRequestsOverride,
			Long photosMaxItemsOverride, long blockBackoffMs) {
		this(configPath, maxCourtsOverride, maxRequestsOverride, photosMaxItemsOverride, blockBackoffMs, null);
	}

	@Autowired
	public CollectorSettings(@Value("${auctionboss.config-path:}") String configPath,
			@Value("${auctionboss.collector.max-courts-per-run:#{null}}") Long maxCourtsOverride,
			@Value("${auctionboss.collector.max-requests-per-run:#{null}}") Long maxRequestsOverride,
			@Value("${auctionboss.photos.max-items-per-run:#{null}}") Long photosMaxItemsOverride,
			@Value("${auctionboss.collector.block-backoff-ms:" + DEFAULT_BLOCK_BACKOFF_MS + "}") long blockBackoffMs,
			@Value("${auctionboss.photos.only-item-id:#{null}}") Long photosOnlyItemId) {
		this.photosOnlyItemId = checkOverride(photosOnlyItemId, "auctionboss.photos.only-item-id");
		this.configPath = configPath;
		this.maxCourtsOverride = checkOverride(maxCourtsOverride, "auctionboss.collector.max-courts-per-run");
		this.maxRequestsOverride = checkOverride(maxRequestsOverride, "auctionboss.collector.max-requests-per-run");
		this.photosMaxItemsOverride = checkOverride(photosMaxItemsOverride, "auctionboss.photos.max-items-per-run");
		this.blockBackoffMs = checkOverride(blockBackoffMs, "auctionboss.collector.block-backoff-ms");
	}

	public Scope scope() {
		JsonNode scope = section("scope");
		JsonNode courtsNode = scope.path("courts");
		if (!courtsNode.isArray() || courtsNode.isEmpty()) {
			throw invalid("scope.courts", "수집 대상 법원이 최소 1곳은 있어야 합니다");
		}
		List<CourtRef> courts = new ArrayList<>();
		for (int i = 0; i < courtsNode.size(); i++) {
			JsonNode court = courtsNode.get(i);
			JsonNode name = court.path("name");
			if (!name.isString() || name.stringValue().isEmpty()) {
				throw invalid("scope.courts." + i + ".name", "법원 이름(name)은 비어 있을 수 없습니다");
			}
			JsonNode code = court.path("courtCode");
			if (!code.isString()) {
				throw invalid("scope.courts." + i + ".courtCode", "문자열이어야 합니다");
			}
			courts.add(new CourtRef(name.stringValue(), code.stringValue()));
		}
		long maxCourts = maxCourtsOverride != null ? maxCourtsOverride
				: positiveInt(scope.path("maxCourtsPerRun"), "scope.maxCourtsPerRun");
		long maxRequests = maxRequestsOverride != null ? maxRequestsOverride
				: positiveInt(scope.path("maxRequestsPerRun"), "scope.maxRequestsPerRun");
		return new Scope(courts, maxCourts, maxRequests);
	}

	/** 수집 주기(ms). 스케줄러가 기동 시 한 번 읽는다. */
	public long intervalMs() {
		return positiveInt(root().path("intervalMs"), "intervalMs");
	}

	public Photos photos() {
		JsonNode photos = section("photos");
		long maxItems = photosMaxItemsOverride != null ? photosMaxItemsOverride
				: positiveInt(photos.path("maxItemsPerRun"), "photos.maxItemsPerRun");
		return new Photos(positiveInt(photos.path("intervalMs"), "photos.intervalMs"), maxItems,
				positiveInt(photos.path("requestDelayMs"), "photos.requestDelayMs"),
				positiveInt(photos.path("retryAfterHours"), "photos.retryAfterHours"));
	}

	/** 1회 실행용: 사진 대상을 이 물건 하나로 좁힌다(대기 조건은 그대로 적용). 없으면 좁히지 않는다. */
	public Optional<Long> photosOnlyItemId() {
		return Optional.ofNullable(photosOnlyItemId);
	}

	/** 차단 감지 시 백오프 길이(ms). */
	public long blockBackoffMs() {
		return blockBackoffMs;
	}

	private JsonNode section(String name) {
		JsonNode node = root().path(name);
		if (!node.isObject()) {
			throw invalid(name, "객체여야 합니다");
		}
		return node;
	}

	private JsonNode root() {
		Path path = resolvePath();
		try {
			return MAPPER.readTree(Files.readString(path));
		}
		catch (IOException | RuntimeException e) {
			throw new IllegalStateException("수집 설정 파일을 읽지 못했습니다: " + path, e);
		}
	}

	/** zod {@code z.number().int().positive()}: 정수값인 JSON 숫자({@code 3.0} 포함)만, 0 이하와 문자열은 거절. */
	private long positiveInt(JsonNode node, String field) {
		if (!node.isNumber()) {
			throw invalid(field, "숫자여야 합니다");
		}
		double d = node.doubleValue();
		if (Double.isNaN(d) || Double.isInfinite(d) || d != Math.floor(d)) {
			throw invalid(field, "정수여야 합니다");
		}
		if (d <= 0) {
			throw invalid(field, "0보다 커야 합니다");
		}
		if (d > MAX_SAFE) {
			throw invalid(field, "너무 큽니다");
		}
		return (long) d;
	}

	private IllegalStateException invalid(String field, String problem) {
		return new IllegalStateException("수집 설정 형식이 올바르지 않습니다 - " + field + ": " + problem);
	}

	private static Long checkOverride(Long value, String property) {
		if (value != null && value < 1) {
			throw new IllegalStateException(property + "은(는) 1 이상의 정수여야 합니다");
		}
		return value;
	}

	private static long checkOverride(long value, String property) {
		checkOverride(Long.valueOf(value), property);
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
