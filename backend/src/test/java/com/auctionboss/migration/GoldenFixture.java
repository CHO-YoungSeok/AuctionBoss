package com.auctionboss.migration;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.util.Comparator;
import java.util.stream.Stream;

import org.springframework.core.io.FileSystemResource;
import org.springframework.core.io.support.EncodedResource;
import org.springframework.jdbc.datasource.init.ScriptUtils;

/** 교차 언어 골든({@code src/test/resources/migration}, TS가 만든 SQL·매니페스트·사진)을 다루는 테스트 도구. */
final class GoldenFixture {

	/** Gradle 테스트의 작업 디렉터리는 backend/다. */
	static final Path DIR = Path.of("src/test/resources/migration");

	private GoldenFixture() {
	}

	static MigrationManifest manifest() {
		return MigrationManifest.read(DIR.resolve("manifest.json"));
	}

	/** 골든 SQL 8개를 FK 순서로 연결 위에서 실행한다(트랜잭션은 호출자가 정한다). */
	static void loadSql(Connection connection, MigrationManifest manifest) {
		for (String table : ImportService.TABLES) {
			MigrationManifest.Table t = manifest.tables().get(table);
			if (t.rows() > 0) {
				ScriptUtils.executeSqlScript(connection,
						new EncodedResource(new FileSystemResource(DIR.resolve("sql").resolve(t.file())), StandardCharsets.UTF_8));
			}
		}
	}

	/** 골든 전체를 쓸 수 있는 임시 디렉터리로 복사한다(변형 시험용). */
	static Path copy() {
		try {
			Path target = Files.createTempDirectory("auctionboss-golden-");
			try (Stream<Path> walk = Files.walk(DIR)) {
				for (Path p : (Iterable<Path>) walk::iterator) {
					Path dest = target.resolve(DIR.relativize(p).toString());
					if (Files.isDirectory(p)) {
						Files.createDirectories(dest);
					}
					else {
						Files.copy(p, dest);
					}
				}
			}
			return target;
		}
		catch (IOException e) {
			throw new UncheckedIOException(e);
		}
	}

	static void deleteTree(Path root) {
		try (Stream<Path> walk = Files.walk(root)) {
			walk.sorted(Comparator.reverseOrder()).forEach(p -> p.toFile().delete());
		}
		catch (IOException e) {
			throw new UncheckedIOException(e);
		}
	}

	static String read(Path file) {
		try {
			return Files.readString(file, StandardCharsets.UTF_8);
		}
		catch (IOException e) {
			throw new UncheckedIOException(e);
		}
	}

	static void write(Path file, String text) {
		try {
			Files.writeString(file, text, StandardCharsets.UTF_8);
		}
		catch (IOException e) {
			throw new UncheckedIOException(e);
		}
	}

}
