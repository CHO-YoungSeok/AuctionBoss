package com.auctionboss.collect.photos;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Base64;

import com.auctionboss.photo.PhotoFileStore;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/** 6.2: 사진 파일 저장(TS {@code saveBase64Photo}와 같은 규칙). */
class PhotoFileWriterTest {

	@TempDir
	Path base;

	private Path photos;

	private PhotoFileStore store;

	private PhotoFileWriter writer;

	@BeforeEach
	void setUp() throws Exception {
		photos = Files.createDirectories(base.resolve("photos"));
		store = new PhotoFileStore(photos.toString());
		writer = new PhotoFileWriter(store);
	}

	private static String b64(int... bytes) {
		byte[] raw = new byte[bytes.length];
		for (int i = 0; i < bytes.length; i++) {
			raw[i] = (byte) bytes[i];
		}
		return Base64.getEncoder().encodeToString(raw);
	}

	private void assertSaved(String base64, String expectedPath, String mime) throws Exception {
		byte[] expected = Base64.getDecoder().decode(base64);
		PhotoFileWriter.Saved saved = writer.save(7, 1, base64);

		assertThat(saved.filePath()).isEqualTo(expectedPath);
		assertThat(saved.mimeType()).isEqualTo(mime);
		assertThat(saved.fileSize()).isEqualTo(expected.length);
		assertThat(Files.readAllBytes(photos.resolve(expectedPath))).isEqualTo(expected);
		assertThat(store.read(saved.filePath())).hasValue(expected);
	}

	@Test
	void JPEG는_jpg로_저장한다() throws Exception {
		assertSaved(b64(0xff, 0xd8, 0xff, 0xe0, 1, 2), "7/1.jpg", "image/jpeg");
	}

	@Test
	void PNG는_png로_저장한다() throws Exception {
		assertSaved(b64(0x89, 'P', 'N', 'G', 0x0d, 0x0a), "7/1.png", "image/png");
	}

	@Test
	void GIF87a와_GIF89a는_gif로_저장한다() throws Exception {
		assertSaved(b64('G', 'I', 'F', '8', '7', 'a', 1), "7/1.gif", "image/gif");
		assertSaved(b64('G', 'I', 'F', '8', '9', 'a', 1), "7/1.gif", "image/gif");
	}

	@Test
	void 알_수_없는_형식과_GIF_변종은_bin이다() throws Exception {
		assertSaved(b64(1, 2, 3, 4), "7/1.bin", "application/octet-stream");
		assertSaved(b64('G', 'I', 'F', '8', '8', 'a'), "7/1.bin", "application/octet-stream");
		assertSaved(b64('G', 'I', 'F', '8', '7'), "7/1.bin", "application/octet-stream");
		assertSaved(b64(0xff, 0xd8), "7/1.bin", "application/octet-stream");
		assertSaved("", "7/1.bin", "application/octet-stream");
	}

	@Test
	void 경로는_물건_id와_순번으로_정해지고_같은_이름이면_덮어쓴다() throws Exception {
		writer.save(12, 3, b64(0xff, 0xd8, 0xff, 1));
		PhotoFileWriter.Saved second = writer.save(12, 3, b64(0xff, 0xd8, 0xff, 2, 3));

		assertThat(second.filePath()).isEqualTo("12/3.jpg");
		assertThat(Files.readAllBytes(photos.resolve("12/3.jpg"))).hasSize(5);
	}

	@Test
	void base64_길이가_10MB를_넘으면_거절하고_파일을_만들지_않는다() {
		String tooLong = "A".repeat(PhotoFileWriter.MAX_BASE64_LENGTH + 1);

		assertThatThrownBy(() -> writer.save(7, 1, tooLong)).isInstanceOf(IllegalStateException.class)
			.hasMessageContaining("10MB");
		assertThat(photos.resolve("7")).doesNotExist();
	}

	@Test
	void 정확히_10MB는_허용한다() {
		String atLimit = "A".repeat(PhotoFileWriter.MAX_BASE64_LENGTH);

		PhotoFileWriter.Saved saved = writer.save(7, 1, atLimit);

		assertThat(saved.fileSize()).isEqualTo(PhotoFileWriter.MAX_BASE64_LENGTH / 4 * 3);
	}

	@Test
	void 사진_디렉터리_밖_경로는_거절한다() {
		// 쓰기는 읽기와 같은 경계 검사(PhotoFileStore.locate)를 거친다
		assertThat(store.locate("../escape.jpg")).isEmpty();
		assertThat(store.locate("7/../../escape.jpg")).isEmpty();
		assertThat(store.locate(base.resolve("elsewhere/x.jpg").toString())).isEmpty();
		assertThat(store.locate("7/1.jpg")).hasValue(photos.toAbsolutePath().normalize().resolve("7/1.jpg"));
	}

	@Test
	void 음수_순번이나_큰_id도_사진_디렉터리_안에만_쓴다() throws Exception {
		PhotoFileWriter.Saved saved = writer.save(Long.MAX_VALUE, -1, b64(0xff, 0xd8, 0xff));

		assertThat(saved.filePath()).isEqualTo(Long.MAX_VALUE + "/-1.jpg");
		try (var walk = Files.walk(base)) {
			assertThat(walk.filter(Files::isRegularFile).allMatch(p -> p.startsWith(photos))).isTrue();
		}
	}

	@Test
	void base64는_Node처럼_관대하게_읽는다() {
		byte[] expected = { (byte) 0xff, (byte) 0xd8, (byte) 0xff, (byte) 0xfb, (byte) 0xef };
		String standard = Base64.getEncoder().encodeToString(expected);
		assertThat(PhotoFileWriter.decode(standard)).isEqualTo(expected);
		assertThat(PhotoFileWriter.decode(standard.replace("=", ""))).as("패딩 없음").isEqualTo(expected);
		assertThat(PhotoFileWriter.decode(Base64.getUrlEncoder().encodeToString(expected))).as("URL 안전 문자")
			.isEqualTo(expected);
		assertThat(PhotoFileWriter.decode(standard.substring(0, 2) + "\n " + standard.substring(2))).as("공백 무시")
			.isEqualTo(expected);
		assertThat(PhotoFileWriter.decode("/9j/4")).as("남는 한 글자는 버린다").isEqualTo(PhotoFileWriter.decode("/9j/"));
	}

}
