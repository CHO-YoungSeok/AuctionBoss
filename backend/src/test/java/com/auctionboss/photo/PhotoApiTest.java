package com.auctionboss.photo;

import static com.auctionboss.support.TestData.item;
import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;

import com.auctionboss.item.Item;
import com.auctionboss.item.ItemRepository;
import com.auctionboss.support.AbstractMySqlTest;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;

/** 5.2: GET /api/photos/{itemId}/{seq}. 사진 디렉터리는 임시 디렉터리다. */
@AutoConfigureMockMvc
class PhotoApiTest extends AbstractMySqlTest {

	private static final byte[] PNG = { (byte) 0x89, 'P', 'N', 'G', 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4 };

	private static final byte[] JPEG = { (byte) 0xff, (byte) 0xd8, (byte) 0xff, (byte) 0xe0, 9, 8, 7 };

	private static Path root;

	private static Path outsideFile;

	@BeforeAll
	static void createDirectories() throws Exception {
		Path base = Files.createTempDirectory("auctionboss-photos-");
		root = Files.createDirectories(base.resolve("photos"));
		outsideFile = Files.write(Files.createDirectories(base.resolve("elsewhere")).resolve("secret.png"),
				"TOP-SECRET".getBytes(StandardCharsets.UTF_8));
	}

	@DynamicPropertySource
	static void photoDirectory(DynamicPropertyRegistry registry) throws Exception {
		if (root == null) {
			createDirectories();
		}
		registry.add("auctionboss.photos.dir", () -> root.toString());
	}

	@Autowired
	MockMvc mvc;
	@Autowired
	ItemRepository items;
	@Autowired
	ItemPhotoRepository photos;

	private Item savedItem() {
		return items.save(item("2026타경" + System.nanoTime(), "1").build());
	}

	private void record(Item it, int seq, String filePath, String mime) {
		photos.save(new ItemPhoto(it, seq, filePath, 10L, mime, Instant.parse("2026-10-08T00:00:00Z")));
	}

	private Path write(String relative, byte[] bytes) throws Exception {
		Path file = root.resolve(relative);
		Files.createDirectories(file.getParent());
		return Files.write(file, bytes);
	}

	private MvcResult call(String path) throws Exception {
		return mvc.perform(get(path)).andReturn();
	}

	@Test
	void servesTheStoredBytesWithMimeTypeAndCacheHeaders() throws Exception {
		Item it = savedItem();
		write(it.getId() + "/1.png", PNG);
		write(it.getId() + "/2.jpg", JPEG);
		record(it, 1, it.getId() + "/1.png", "image/png");
		record(it, 2, it.getId() + "/2.jpg", "image/jpeg");

		MvcResult png = call("/api/photos/" + it.getId() + "/1");
		MvcResult jpeg = call("/api/photos/" + it.getId() + "/2");

		assertThat(png.getResponse().getStatus()).isEqualTo(200);
		assertThat(png.getResponse().getContentAsByteArray()).isEqualTo(PNG);
		assertThat(png.getResponse().getHeader("Content-Type")).isEqualTo("image/png");
		assertThat(png.getResponse().getHeader("Cache-Control")).isEqualTo("public, max-age=86400, immutable");
		assertThat(jpeg.getResponse().getContentAsByteArray()).isEqualTo(JPEG);
		assertThat(jpeg.getResponse().getHeader("Content-Type")).isEqualTo("image/jpeg");
	}

	@Test
	void absoluteRecordedPathsInsideTheDirectoryAreServed() throws Exception {
		Item it = savedItem();
		Path file = write("abs/" + it.getId() + ".png", PNG);
		record(it, 1, file.toString(), "image/png");

		assertThat(call("/api/photos/" + it.getId() + "/1").getResponse().getContentAsByteArray()).isEqualTo(PNG);
	}

	@Test
	void unknownSequenceAndUnknownItemAreNotFoundAsText() throws Exception {
		Item it = savedItem();
		write(it.getId() + "/1.png", PNG);
		record(it, 1, it.getId() + "/1.png", "image/png");

		MvcResult noSeq = call("/api/photos/" + it.getId() + "/9");
		MvcResult noItem = call("/api/photos/" + (it.getId() + 1000) + "/1");

		for (MvcResult r : new MvcResult[] { noSeq, noItem }) {
			assertThat(r.getResponse().getStatus()).isEqualTo(404);
			assertThat(r.getResponse().getContentAsString()).isEqualTo("Not Found");
			assertThat(r.getResponse().getContentType()).startsWith("text/plain");
		}
	}

	@Test
	void recordedButUnreadableFileIsFileNotFound() throws Exception {
		Item it = savedItem();
		record(it, 1, it.getId() + "/gone.png", "image/png");

		MvcResult r = call("/api/photos/" + it.getId() + "/1");

		assertThat(r.getResponse().getStatus()).isEqualTo(404);
		assertThat(r.getResponse().getContentAsString()).isEqualTo("File Not Found");
	}

	@Test
	void recordedPathsOutsideThePhotoDirectoryAreFileNotFoundAndNeverLeakContent() throws Exception {
		Item it = savedItem();
		record(it, 1, outsideFile.toString(), "image/png");
		record(it, 2, "../elsewhere/secret.png", "image/png");
		Path sibling = Files.write(Files.createDirectories(root.resolveSibling(root.getFileName() + "2"))
				.resolve("x.png"), "SIBLING".getBytes(StandardCharsets.UTF_8));
		record(it, 3, sibling.toString(), "image/png");

		for (int seq = 1; seq <= 3; seq++) {
			MvcResult r = call("/api/photos/" + it.getId() + "/" + seq);
			assertThat(r.getResponse().getStatus()).as("seq " + seq).isEqualTo(404);
			assertThat(r.getResponse().getContentAsString()).as("seq " + seq).isEqualTo("File Not Found");
		}
	}

	@Test
	void nonNumericIdsAreInvalidId() throws Exception {
		for (String path : new String[] { "/api/photos/abc/1", "/api/photos/1/abc", "/api/photos/-/1",
				"/api/photos/%20/1" }) {
			MvcResult r = call(path);
			assertThat(r.getResponse().getStatus()).as(path).isEqualTo(400);
			assertThat(r.getResponse().getContentAsString()).as(path).isEqualTo("Invalid ID");
			assertThat(r.getResponse().getContentType()).as(path).startsWith("text/plain");
		}
	}

	@Test
	void parseIntSemanticsReadTheLeadingIntegerOnly() throws Exception {
		Item it = savedItem();
		write(it.getId() + "/1.png", PNG);
		record(it, 1, it.getId() + "/1.png", "image/png");

		// "<id>abc"는 id로, "1.9"는 1로 읽힌다(JS parseInt).
		MvcResult trailing = call("/api/photos/" + it.getId() + "abc/1");
		MvcResult fraction = call("/api/photos/" + it.getId() + "/1.9");

		assertThat(trailing.getResponse().getStatus()).isEqualTo(200);
		assertThat(trailing.getResponse().getContentAsByteArray()).isEqualTo(PNG);
		assertThat(fraction.getResponse().getStatus()).isEqualTo(200);
		MvcResult huge = call("/api/photos/99999999999999999999999/1");
		assertThat(huge.getResponse().getStatus()).isEqualTo(404);
		assertThat(huge.getResponse().getContentAsString()).isEqualTo("Not Found");
		assertThat(call("/api/photos/" + it.getId() + "/99999999999").getResponse().getContentAsString())
				.isEqualTo("Not Found");
	}

}
