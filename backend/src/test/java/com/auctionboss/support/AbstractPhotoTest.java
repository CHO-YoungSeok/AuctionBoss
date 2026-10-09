package com.auctionboss.support;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Comparator;
import java.util.stream.Stream;

import com.auctionboss.collect.photos.PendingPhotoQuery;
import com.auctionboss.collect.photos.PhotoFileWriter;
import com.auctionboss.collect.photos.PhotoSaveService;
import com.auctionboss.collect.run.BackoffStore;
import com.auctionboss.worker.WorkerRunService;
import org.junit.jupiter.api.BeforeEach;
import org.springframework.context.annotation.Import;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.context.bean.override.mockito.MockitoSpyBean;

/**
 * 사진 워커 통합 테스트의 베이스: 가짜 소스·가짜 Sleeper·가변 시계와 임시 사진 디렉터리({@code auctionboss.photos.dir}). 사진 테스트가 같은
 * 스프링 컨텍스트를 공유하도록 설정을 이 클래스에 모았다(컨텍스트마다 연결 풀을 쥐므로 늘리지 않는다). 디렉터리는 테스트마다 비운다.
 */
@Import({ FixedClockConfig.class, FakeSourceConfig.class })
public abstract class AbstractPhotoTest extends AbstractMySqlTest {

	private static final Path PHOTOS_DIR = createDirectory();

	private static Path createDirectory() {
		try {
			return Files.createTempDirectory("auctionboss-photo-run-");
		}
		catch (IOException e) {
			throw new UncheckedIOException(e);
		}
	}

	/** 기록 실패·저장 실패를 주입하기 위한 스파이. 스파이를 이 클래스에 모아야 하위 테스트 클래스들이 컨텍스트를 공유한다. */
	@MockitoSpyBean
	protected PendingPhotoQuery pendingQuery;

	@MockitoSpyBean
	protected PhotoFileWriter fileWriter;

	@MockitoSpyBean
	protected PhotoSaveService photoSaves;

	@MockitoSpyBean
	protected WorkerRunService workerRuns;

	@MockitoSpyBean
	protected BackoffStore backoffStore;

	@DynamicPropertySource
	static void photosDirectory(DynamicPropertyRegistry registry) {
		registry.add("auctionboss.photos.dir", PHOTOS_DIR::toString);
	}

	protected static Path photosDir() {
		return PHOTOS_DIR;
	}

	@BeforeEach
	protected void cleanPhotosDirectory() {
		emptyPhotosDir();
	}

	/** 사진 디렉터리 안을 전부 지운다(디렉터리 자체는 남긴다). */
	protected static void emptyPhotosDir() {
		try (Stream<Path> walk = Files.walk(PHOTOS_DIR)) {
			walk.sorted(Comparator.reverseOrder()).filter(p -> !p.equals(PHOTOS_DIR)).forEach(p -> {
				try {
					Files.delete(p);
				}
				catch (IOException e) {
					throw new UncheckedIOException(e);
				}
			});
		}
		catch (IOException e) {
			throw new UncheckedIOException(e);
		}
	}

}
