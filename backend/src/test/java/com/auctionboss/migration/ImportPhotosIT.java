package com.auctionboss.migration;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.test.web.servlet.MvcResult;

/**
 * 3.3: 사진 복사·대조(D8). 골든 사진(원본 SQLite 쪽 파일 3개, 기록 없는 고아 1개는 내보내기가 제외)을 사진 디렉터리에 옮기고, 해시가 다르거나 경계 밖인
 * 경로면 실패·롤백하며 사진 디렉터리에 새 파일이 남지 않는다.
 */
class ImportPhotosIT extends AbstractImportTest {

	private Path temp;

	@AfterEach
	void deleteTemp() {
		if (temp != null) {
			GoldenFixture.deleteTree(temp);
			temp = null;
		}
	}

	@Test
	void 골든_사진이_같은_상대_경로에_같은_해시로_생기고_사진_API가_같은_바이트를_준다() throws Exception {
		ImportReport report = importGolden(false, false);

		assertThat(report.success()).as(report.text()).isTrue();
		assertThat(report.text()).contains("사진 3개 확인(새로 복사 3, 이미 같은 파일 0), 기록 없는 파일 1개는 옮기지 않음");
		MigrationManifest manifest = GoldenFixture.manifest();
		assertThat(manifest.photos()).hasSize(3);
		for (MigrationManifest.Photo photo : manifest.photos()) {
			byte[] copied = Files.readAllBytes(photosDir().resolve(photo.path()));
			assertThat(copied).hasSize((int) photo.size());
			assertThat(PhotoImporter.sha256(copied)).as(photo.path()).isEqualTo(photo.sha256());
		}
		// 기록 없는 파일은 옮기지 않았다(파일은 정확히 매니페스트 3개).
		try (var walk = Files.walk(photosDir())) {
			assertThat(walk.filter(Files::isRegularFile).count()).isEqualTo(3);
		}
		// 사진 파일 API: 물건 7의 사진 둘과 물건 1200의 사진.
		Map<String, String> expected = Map.of("7/1", "7/1.jpg", "7/2", "7/2.png", "1200/1", "1200/1.jpg");
		for (Map.Entry<String, String> e : expected.entrySet()) {
			MvcResult result = mvc.perform(get("/api/photos/" + e.getKey())).andReturn();
			assertThat(result.getResponse().getStatus()).as(e.getKey()).isEqualTo(200);
			assertThat(result.getResponse().getContentAsByteArray())
				.isEqualTo(Files.readAllBytes(GoldenFixture.DIR.resolve("photos").resolve(e.getValue())));
		}
	}

	@Test
	void 해시가_다른_원본_파일이면_실패하고_롤백하며_사진_디렉터리에_새_파일이_없다() throws Exception {
		temp = GoldenFixture.copy();
		Files.writeString(temp.resolve("photos/7/2.png"), "tampered");

		ImportReport report = service.run(new ImportOptions(temp, false, false));

		assertThat(report.success()).isFalse();
		assertThat(report.text()).contains("크기 또는 해시가 매니페스트와 다릅니다");
		assertThat(counts().values()).containsOnly(0L);
		assertThat(markerExists()).isFalse();
		assertThat(photosDirEmpty()).isTrue();
	}

	@Test
	void 복사_뒤_대상_파일이_달라지면_실패하고_새로_만든_파일과_디렉터리를_되돌린다() throws Exception {
		hook.afterPhotos = root -> {
			try {
				Files.writeString(root.resolve("7/2.png"), "changed after copy");
			}
			catch (java.io.IOException e) {
				throw new java.io.UncheckedIOException(e);
			}
		};

		ImportReport report = importGolden(false, false);

		assertThat(report.success()).isFalse();
		assertThat(report.text()).contains("복사한 사진 파일의 크기 또는 해시가 매니페스트와 다릅니다");
		assertThat(counts().values()).containsOnly(0L);
		assertThat(photosDirEmpty()).isTrue();
	}

	@Test
	void 경계_밖_경로는_원본_파일이_있어도_거부한다() throws Exception {
		temp = GoldenFixture.copy();
		// 사진 기록과 매니페스트가 같은 경계 밖 경로를 가리키게 하고, 그 경로의 파일을 실제로 만들어 "없는 파일"이 아니라 "경계"로 거부되게 한다.
		Path sql = temp.resolve("sql/08_item_photos.sql");
		GoldenFixture.write(sql, GoldenFixture.read(sql).replace("'7/1.jpg'", "'../7/1.jpg'"));
		Path manifest = temp.resolve("manifest.json");
		GoldenFixture.write(manifest, GoldenFixture.read(manifest).replace("\"path\": \"7/1.jpg\"", "\"path\": \"../7/1.jpg\""));
		Files.createDirectories(temp.resolve("7"));
		Files.copy(GoldenFixture.DIR.resolve("photos/7/1.jpg"), temp.resolve("7/1.jpg"));
		Path outside = photosDir().getParent().resolve("7/1.jpg");
		assertThat(outside).doesNotExist();
		// SQL을 바꿨으므로 item_photos 해시가 달라진다: 첫 시도가 보고한 대상 해시로 매니페스트를 맞춘다(경계 검사까지 가게 하려는 것).
		String firstTry = service.run(new ImportOptions(temp, false, false)).text();
		java.util.regex.Matcher actual = java.util.regex.Pattern.compile("검증 item_photos: 행 3/3, sha256 ([0-9a-f]{64})").matcher(firstTry);
		assertThat(actual.find()).as(firstTry).isTrue();
		GoldenFixture.write(manifest, GoldenFixture.read(manifest).replace(GoldenFixture.manifest().tables().get("item_photos").sha256(), actual.group(1)));

		ImportReport report = service.run(new ImportOptions(temp, false, false));

		assertThat(report.success()).isFalse();
		assertThat(report.text()).contains("사진 경로가 사진 디렉터리 밖입니다");
		assertThat(counts().values()).containsOnly(0L);
		assertThat(photosDirEmpty()).isTrue();
		assertThat(outside).doesNotExist();
	}

	@Test
	void 드라이런은_사진_디렉터리를_바꾸지_않는다() {
		ImportReport report = importGolden(false, true);

		assertThat(report.success()).as(report.text()).isTrue();
		assertThat(report.text()).contains("사진 3개 확인(새로 복사 3");
		assertThat(photosDirEmpty()).isTrue();
	}

	@Test
	void 같은_경로에_다른_내용의_파일이_있으면_교체_없이는_거부하고_파일을_건드리지_않는다() throws Exception {
		Files.createDirectories(photosDir().resolve("7"));
		Files.writeString(photosDir().resolve("7/1.jpg"), "existing different");

		ImportReport report = importGolden(false, false);

		assertThat(report.success()).isFalse();
		assertThat(report.text()).contains("다른 내용의 파일이 이미 있습니다");
		assertThat(Files.readString(photosDir().resolve("7/1.jpg"))).isEqualTo("existing different");
		assertThat(counts().values()).containsOnly(0L);
	}

	@Test
	void 교체_모드는_덮어쓰고_뒤에서_실패하면_덮어쓴_파일을_되돌리고_새_파일을_지운다() throws Exception {
		Files.createDirectories(photosDir().resolve("7"));
		Files.writeString(photosDir().resolve("7/1.jpg"), "existing different");
		hook.afterPhotos = root -> {
			try {
				Files.writeString(root.resolve("1200/1.jpg"), "changed after copy");
			}
			catch (java.io.IOException e) {
				throw new java.io.UncheckedIOException(e);
			}
		};

		ImportReport failed = importGolden(true, false);

		assertThat(failed.success()).isFalse();
		assertThat(Files.readString(photosDir().resolve("7/1.jpg"))).isEqualTo("existing different");
		try (var walk = Files.walk(photosDir())) {
			assertThat(walk.filter(Files::isRegularFile).map(p -> photosDir().relativize(p).toString()).toList())
				.containsExactly("7/1.jpg");
		}

		hook.afterPhotos = root -> {
		};
		ImportReport ok = importGolden(true, false);

		assertThat(ok.success()).as(ok.text()).isTrue();
		assertThat(PhotoImporter.sha256(Files.readAllBytes(photosDir().resolve("7/1.jpg"))))
			.isEqualTo(GoldenFixture.manifest().photos().stream().filter(p -> p.path().equals("7/1.jpg")).findFirst().orElseThrow().sha256());
		// 같은 내용으로 한 번 더: 이미 같은 파일이므로 복사 0.
		ImportReport again = importGolden(true, false);
		assertThat(again.text()).contains("새로 복사 0, 이미 같은 파일 3");
		assertThat(List.of(counts().get("item_photos"))).containsExactly(3L);
	}

}
