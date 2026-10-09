package com.auctionboss.collect.photos;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Base64;

import com.auctionboss.photo.PhotoFileStore;
import org.springframework.stereotype.Component;

/**
 * 사진 파일 저장(TS {@code saveBase64Photo}). 사진 디렉터리({@code auctionboss.photos.dir}) 아래 {@code {itemId}/{seq}{ext}}에 쓰고,
 * DB에는 사진 디렉터리 기준 상대 경로({@code /} 구분)를 기록하게 돌려준다. 사진 파일 API가 읽는 디렉터리와 경계 검사는
 * {@link PhotoFileStore}와 같다.
 *
 * <p>
 * 형식은 매직 바이트로 정한다: JPEG({@code FF D8 FF}), PNG({@code 89 50 4E 47}), GIF({@code GIF87a}·{@code GIF89a}), 그 밖은
 * {@code .bin}. base64 문자열이 10MB(문자 수)를 넘으면 거절한다.
 */
@Component
public class PhotoFileWriter {

	/** TS {@code MAX_BASE64_SIZE}: base64 문자열의 길이 상한. */
	public static final int MAX_BASE64_LENGTH = 10 * 1024 * 1024;

	/** {@code filePath}는 사진 디렉터리 기준 상대 경로다. */
	public record Saved(String filePath, long fileSize, String mimeType) {
	}

	private record PhotoType(String ext, String mimeType) {
	}

	private final PhotoFileStore store;

	PhotoFileWriter(PhotoFileStore store) {
		this.store = store;
	}

	public Saved save(long itemId, long seq, String base64) {
		if (base64.length() > MAX_BASE64_LENGTH) {
			throw new IllegalStateException("사진 파일 크기가 10MB를 초과했습니다.");
		}
		byte[] bytes = decode(base64);
		PhotoType type = typeOf(bytes);
		String relative = itemId + "/" + seq + type.ext();
		Path target = store.locate(relative)
			.orElseThrow(() -> new IllegalStateException("사진 디렉터리 밖에는 쓸 수 없습니다: " + relative));
		try {
			Files.createDirectories(target.getParent());
			Files.write(target, bytes);
		}
		catch (IOException e) {
			throw new UncheckedIOException(e);
		}
		return new Saved(relative, bytes.length, type.mimeType());
	}

	private static PhotoType typeOf(byte[] b) {
		if (b.length >= 3 && (b[0] & 0xff) == 0xff && (b[1] & 0xff) == 0xd8 && (b[2] & 0xff) == 0xff) {
			return new PhotoType(".jpg", "image/jpeg");
		}
		if (b.length >= 4 && (b[0] & 0xff) == 0x89 && b[1] == 'P' && b[2] == 'N' && b[3] == 'G') {
			return new PhotoType(".png", "image/png");
		}
		if (b.length >= 6 && b[0] == 'G' && b[1] == 'I' && b[2] == 'F' && b[3] == '8' && (b[4] == '7' || b[4] == '9')
				&& b[5] == 'a') {
			return new PhotoType(".gif", "image/gif");
		}
		return new PhotoType(".bin", "application/octet-stream");
	}

	/**
	 * Node {@code Buffer.from(text, "base64")}처럼 관대하게 읽는다: URL 안전 문자({@code - _})도 받고, 알파벳 밖 문자(공백 등)는 무시하고,
	 * 첫 {@code =}에서 끝내며, 패딩이 없어도 되고, 남는 한 글자는 버린다.
	 */
	static byte[] decode(String text) {
		StringBuilder clean = new StringBuilder(text.length());
		for (int i = 0; i < text.length(); i++) {
			char c = text.charAt(i);
			if (c == '=') {
				break;
			}
			if (c == '-') {
				c = '+';
			}
			else if (c == '_') {
				c = '/';
			}
			if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '+' || c == '/') {
				clean.append(c);
			}
		}
		if (clean.length() % 4 == 1) {
			clean.setLength(clean.length() - 1);
		}
		return Base64.getDecoder().decode(clean.toString());
	}

}
