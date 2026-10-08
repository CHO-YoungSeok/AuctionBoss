package com.auctionboss.photo;

import static org.assertj.core.api.Assertions.assertThat;

import java.nio.file.Files;
import java.nio.file.Path;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/** 5.1: 사진 디렉터리 경계 검사(상대·절대 경로, {@code ../}, 형제 디렉터리, 파일 없음). */
class PhotoFileStoreTest {

	@TempDir
	Path base;

	private Path photos;

	private PhotoFileStore store;

	@BeforeEach
	void setUp() throws Exception {
		photos = Files.createDirectories(base.resolve("photos"));
		store = new PhotoFileStore(photos.toString());
	}

	private Path file(Path dir, String name, String content) throws Exception {
		Files.createDirectories(dir);
		return Files.writeString(dir.resolve(name), content);
	}

	@Test
	void relativePathsAreResolvedAgainstThePhotoDirectory() throws Exception {
		file(photos.resolve("12"), "1.jpg", "inside");

		assertThat(store.read("12/1.jpg")).hasValue("inside".getBytes());
	}

	@Test
	void absolutePathsInsideTheDirectoryAreServed() throws Exception {
		Path inside = file(photos.resolve("7"), "2.png", "abs");

		assertThat(store.read(inside.toString())).hasValue("abs".getBytes());
	}

	@Test
	void relativeConfigurationIsResolvedToAbsolute() throws Exception {
		Path relativeRoot = Path.of("build", "photo-store-test");
		Files.createDirectories(relativeRoot);
		Files.writeString(relativeRoot.resolve("a.jpg"), "rel");

		assertThat(new PhotoFileStore(relativeRoot.toString()).read("a.jpg")).hasValue("rel".getBytes());
	}

	@Test
	void dotDotEscapesAreRefused() throws Exception {
		file(base, "secret.txt", "secret");
		file(photos.resolve("1"), "ok.jpg", "ok");

		assertThat(store.read("../secret.txt")).isEmpty();
		assertThat(store.read("1/../../secret.txt")).isEmpty();
		// 안에서 되돌아오는 ..는 정규화 뒤 안쪽이므로 허용된다.
		assertThat(store.read("1/../1/ok.jpg")).hasValue("ok".getBytes());
	}

	@Test
	void absolutePathsOutsideTheDirectoryAreRefused() throws Exception {
		Path outside = file(base.resolve("elsewhere"), "x.jpg", "outside");

		assertThat(store.read(outside.toString())).isEmpty();
	}

	@Test
	void aSiblingDirectoryWithTheSameNamePrefixIsRefused() throws Exception {
		// /base/photos2/x.jpg는 문자열로는 "/base/photos"로 시작하지만 사진 디렉터리 안이 아니다.
		Path sibling = file(base.resolve("photos2"), "x.jpg", "sibling");

		assertThat(store.read(sibling.toString())).isEmpty();
		assertThat(store.read("../photos2/x.jpg")).isEmpty();
	}

	@Test
	void missingFilesDirectoriesAndInvalidPathsAreEmpty() throws Exception {
		Files.createDirectories(photos.resolve("dir"));

		assertThat(store.read("nope.jpg")).isEmpty();
		assertThat(store.read("dir")).isEmpty();
		assertThat(store.read("")).isEmpty();
		assertThat(store.read("bad\0name.jpg")).isEmpty();
	}

}
