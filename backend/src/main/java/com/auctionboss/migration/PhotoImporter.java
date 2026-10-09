package com.auctionboss.migration;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.nio.file.InvalidPathException;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HexFormat;
import java.util.List;
import java.util.Optional;

import com.auctionboss.photo.PhotoFileStore;

/**
 * 사진 파일 복사와 대조(D8). 모든 원본 파일을 먼저 확인한 뒤(경계, 크기, 해시) 쓰기 시작하므로 확인에서 걸리면 대상 디렉터리는 그대로다.
 * 쓰기 뒤 되읽어 해시를 다시 대조하고, 실패하거나 커밋하지 못하면 {@link Applied#undo()}가 새로 만든 파일·디렉터리를 지우고 덮어쓴 파일을
 * 되돌린다. 대상 경로는 사진 파일 API가 읽는 {@link PhotoFileStore}와 같은 경계 검사를 쓴다.
 */
final class PhotoImporter {

	/** 복사 결과. {@link #undo()}는 이 복사가 바꾼 것을 되돌린다. */
	static final class Applied {

		private final List<Runnable> undo = new ArrayList<>();

		int copied;

		int unchanged;

		void undo() {
			List<Runnable> reversed = new ArrayList<>(undo);
			Collections.reverse(reversed);
			for (Runnable r : reversed) {
				try {
					r.run();
				}
				catch (RuntimeException ignored) {
					// 되돌리기는 최대한 한다
				}
			}
			undo.clear();
		}

	}

	private record Planned(int index, MigrationManifest.Photo photo, Path source, Path target, byte[] bytes) {
	}

	private PhotoImporter() {
	}

	static String sha256(byte[] bytes) {
		try {
			return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
		}
		catch (NoSuchAlgorithmException e) {
			throw new IllegalStateException(e);
		}
	}

	/**
	 * 원본 확인만 한다(쓰기 없음). 경계 밖 경로, 없는 파일, 크기·해시 불일치는 {@link ImportFailure}다. 메시지에는 매니페스트 안의 순번만 쓴다.
	 */
	private static List<Planned> plan(Path sourceRoot, List<MigrationManifest.Photo> photos, PhotoFileStore target) {
		Path root = sourceRoot.toAbsolutePath().normalize();
		List<Planned> planned = new ArrayList<>();
		for (int i = 0; i < photos.size(); i++) {
			MigrationManifest.Photo photo = photos.get(i);
			Path src;
			Optional<Path> dst;
			try {
				Path relative = Path.of(photo.path());
				if (relative.isAbsolute()) {
					throw new ImportFailure("사진 경로가 사진 디렉터리 밖입니다: 매니페스트 사진 #" + i);
				}
				src = root.resolve(relative).normalize();
				dst = target.locate(photo.path());
			}
			catch (InvalidPathException e) {
				throw new ImportFailure("사진 경로를 해석할 수 없습니다: 매니페스트 사진 #" + i);
			}
			if (!src.startsWith(root) || dst.isEmpty()) {
				throw new ImportFailure("사진 경로가 사진 디렉터리 밖입니다: 매니페스트 사진 #" + i);
			}
			byte[] bytes;
			try {
				if (!Files.isRegularFile(src)) {
					throw new ImportFailure("사진 원본 파일이 없습니다: 매니페스트 사진 #" + i);
				}
				bytes = Files.readAllBytes(src);
			}
			catch (IOException e) {
				throw new UncheckedIOException(e);
			}
			if (bytes.length != photo.size() || !sha256(bytes).equals(photo.sha256())) {
				throw new ImportFailure("사진 원본 파일의 크기 또는 해시가 매니페스트와 다릅니다: 매니페스트 사진 #" + i);
			}
			planned.add(new Planned(i, photo, src, dst.get(), bytes));
		}
		return planned;
	}

	/** 원본을 확인하고 {@code target}에 복사한다. 같은 경로에 다른 내용의 파일이 있으면 {@code replace}일 때만 덮어쓴다. */
	static Applied copy(Path sourceRoot, List<MigrationManifest.Photo> photos, PhotoFileStore target, boolean replace) {
		List<Planned> planned = plan(sourceRoot, photos, target);
		Applied applied = new Applied();
		try {
			for (Planned p : planned) {
				if (Files.exists(p.target())) {
					byte[] existing = Files.readAllBytes(p.target());
					if (Arrays.equals(existing, p.bytes())) {
						applied.unchanged++;
						continue;
					}
					if (!replace) {
						throw new ImportFailure("사진 디렉터리에 다른 내용의 파일이 이미 있습니다(교체 아님): 매니페스트 사진 #" + p.index());
					}
					Files.write(p.target(), p.bytes());
					applied.undo.add(() -> write(p.target(), existing));
					applied.copied++;
					continue;
				}
				createParents(p.target(), applied);
				Files.write(p.target(), p.bytes());
				applied.undo.add(() -> delete(p.target()));
				applied.copied++;
			}
		}
		catch (IOException e) {
			applied.undo();
			throw new UncheckedIOException(e);
		}
		catch (RuntimeException e) {
			applied.undo();
			throw e;
		}
		return applied;
	}

	/** 복사한 파일을 되읽어 해시를 다시 대조한다. */
	static void verify(List<MigrationManifest.Photo> photos, PhotoFileStore target) {
		for (int i = 0; i < photos.size(); i++) {
			MigrationManifest.Photo photo = photos.get(i);
			Path path = target.locate(photo.path())
				.orElseThrow(() -> new ImportFailure("사진 경로가 사진 디렉터리 밖입니다"));
			try {
				byte[] bytes = Files.readAllBytes(path);
				if (bytes.length != photo.size() || !sha256(bytes).equals(photo.sha256())) {
					throw new ImportFailure("복사한 사진 파일의 크기 또는 해시가 매니페스트와 다릅니다: 매니페스트 사진 #" + i);
				}
			}
			catch (IOException e) {
				throw new ImportFailure("복사한 사진 파일을 읽지 못했습니다: 매니페스트 사진 #" + i);
			}
		}
	}

	private static void createParents(Path file, Applied applied) throws IOException {
		List<Path> missing = new ArrayList<>();
		for (Path dir = file.getParent(); dir != null && !Files.exists(dir); dir = dir.getParent()) {
			missing.add(dir);
		}
		for (int i = missing.size() - 1; i >= 0; i--) {
			Path dir = missing.get(i);
			Files.createDirectory(dir);
			applied.undo.add(() -> delete(dir));
		}
	}

	private static void write(Path path, byte[] bytes) {
		try {
			Files.write(path, bytes);
		}
		catch (IOException e) {
			throw new UncheckedIOException(e);
		}
	}

	private static void delete(Path path) {
		try {
			Files.deleteIfExists(path);
		}
		catch (IOException e) {
			throw new UncheckedIOException(e);
		}
	}

}
