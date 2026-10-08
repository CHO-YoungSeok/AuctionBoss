package com.auctionboss.photo;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Optional;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

/**
 * 사진 파일 읽기. 사진 디렉터리({@code auctionboss.photos.dir}) 안의 파일만 내준다.
 *
 * <p>
 * 기록된 경로(상대 경로는 사진 디렉터리 기준, 절대 경로는 그대로)를 정규화한 뒤 {@link Path#startsWith(Path)}로 디렉터리
 * 안인지 확인한다. 이 비교는 경로 구성요소 단위라 형제 디렉터리({@code /data/photos2/..})는 통과하지 못한다. 원본의 문자열
 * {@code startsWith}는 통과시키던 경우이며, 정상 기록에는 영향이 없는 의도된 차이다.
 */
@Component
public class PhotoFileStore {

	private final Path root;

	public PhotoFileStore(@Value("${auctionboss.photos.dir:data/photos}") String dir) {
		this.root = Path.of(dir).toAbsolutePath().normalize();
	}

	/** 읽을 수 없거나 사진 디렉터리 밖이면 비어 있다. */
	public Optional<byte[]> read(String filePath) {
		try {
			Path recorded = Path.of(filePath);
			Path resolved = (recorded.isAbsolute() ? recorded : root.resolve(recorded)).toAbsolutePath().normalize();
			if (!resolved.startsWith(root)) {
				return Optional.empty();
			}
			return Optional.of(Files.readAllBytes(resolved));
		}
		catch (java.io.IOException | RuntimeException e) {
			return Optional.empty();
		}
	}

}
