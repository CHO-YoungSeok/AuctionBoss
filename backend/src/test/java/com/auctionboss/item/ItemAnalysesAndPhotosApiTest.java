package com.auctionboss.item;

import static com.auctionboss.support.TestData.item;
import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;

import com.auctionboss.analysis.Analysis;
import com.auctionboss.analysis.AnalysisRepository;
import com.auctionboss.photo.ItemPhoto;
import com.auctionboss.photo.ItemPhotoRepository;
import com.auctionboss.support.AbstractMySqlTest;
import com.auctionboss.support.FixedClockConfig;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.context.annotation.Import;
import org.springframework.test.web.servlet.MockMvc;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/** 3.6: 분석 이력({@code /api/items/{id}/analyses})과 사진 목록({@code /api/items/{id}/photos}). */
@AutoConfigureMockMvc
@Import(FixedClockConfig.class)
class ItemAnalysesAndPhotosApiTest extends AbstractMySqlTest {

	private static final JsonMapper JSON = JsonMapper.builder().build();

	private static final Instant T = Instant.parse("2026-10-01T00:00:00Z");

	@Autowired
	MockMvc mvc;
	@Autowired
	ItemRepository items;
	@Autowired
	AnalysisRepository analyses;
	@Autowired
	ItemPhotoRepository photos;

	private record Response(int status, JsonNode body) {
	}

	private Response call(String url) throws Exception {
		var response = mvc.perform(get(url)).andReturn().getResponse();
		return new Response(response.getStatus(),
				JSON.readTree(response.getContentAsString(java.nio.charset.StandardCharsets.UTF_8)));
	}

	private Item newItem() {
		return items.save(item("2026타경1", "1").build());
	}

	private void analyze(Item it, int count) {
		for (int i = 1; i <= count; i++) {
			analyses.save(new Analysis(it, "본문" + i, i % 2 == 0 ? "m" : null, "v" + i, T.plusSeconds(i)));
		}
	}

	private static List<String> bodies(JsonNode analyses) {
		List<String> out = new ArrayList<>();
		analyses.forEach(a -> out.add(a.get("body").asString()));
		return out;
	}

	@Test
	void truncatedHistoryKeepsTheTotalAndNewestFirst() throws Exception {
		Item it = newItem();
		analyze(it, 12);

		Response r = call("/api/items/" + it.getId() + "/analyses?limit=11");

		assertThat(r.status()).isEqualTo(200);
		assertThat(r.body().propertyNames()).containsExactly("analyses", "total");
		assertThat(r.body().get("total").asInt()).isEqualTo(12);
		assertThat(bodies(r.body().get("analyses"))).hasSize(11).startsWith("본문12", "본문11").endsWith("본문2");
		assertThat(r.body().get("analyses").get(0).propertyNames()).containsExactly("id", "itemId", "body", "model",
				"promptVersion", "analyzedAt");
		assertThat(r.body().get("analyses").get(0).get("itemId").asLong()).isEqualTo(it.getId());
	}

	@Test
	void defaultLimitIsTenAndLimitOneGivesTheNewest() throws Exception {
		Item it = newItem();
		analyze(it, 12);

		assertThat(call("/api/items/" + it.getId() + "/analyses").body().get("analyses")).hasSize(10);
		Response one = call("/api/items/" + it.getId() + "/analyses?limit=1");
		assertThat(bodies(one.body().get("analyses"))).containsExactly("본문12");
		assertThat(one.body().get("total").asInt()).isEqualTo(12);
		assertThat(call("/api/items/" + it.getId() + "/analyses?limit=50").body().get("analyses")).hasSize(12);
	}

	@Test
	void tiesInAnalyzedAtAreBrokenByIdDescending() throws Exception {
		Item it = newItem();
		analyses.save(new Analysis(it, "먼저", null, "v1", T));
		analyses.save(new Analysis(it, "나중", null, "v1", T));

		assertThat(bodies(call("/api/items/" + it.getId() + "/analyses").body().get("analyses")))
			.containsExactly("나중", "먼저");
	}

	@Test
	void itemWithoutAnalysesGivesEmptyHistory() throws Exception {
		Item it = newItem();

		Response r = call("/api/items/" + it.getId() + "/analyses");

		assertThat(r.status()).isEqualTo(200);
		assertThat(r.body().get("analyses")).isEmpty();
		assertThat(r.body().get("total").asInt()).isZero();
	}

	@Test
	void invalidLimitIs400WithTheLimitField() throws Exception {
		Item it = newItem();
		for (String limit : new String[] { "0", "abc", "51", "", "-1", "1.5", "99999999999999999999" }) {
			Response r = call("/api/items/" + it.getId() + "/analyses?limit=" + limit);

			assertThat(r.status()).as("limit=" + limit).isEqualTo(400);
			assertThat(r.body().get("error").asString()).isEqualTo("잘못된 요청 파라미터입니다");
			assertThat(r.body().get("details").get(0).get("field").asString()).isEqualTo("limit");
		}
	}

	@Test
	void missingOrNonNumericItemIs404WithTheItemMessage() throws Exception {
		for (String id : new String[] { "999999", "abc" }) {
			for (String suffix : new String[] { "analyses", "photos" }) {
				Response r = call("/api/items/" + id + "/" + suffix);

				assertThat(r.status()).as(id + "/" + suffix).isEqualTo(404);
				assertThat(r.body().get("error").asString()).isEqualTo("물건을 찾을 수 없습니다: id=" + id);
			}
		}
		// 없는 물건은 limit 검증보다 먼저 본다.
		assertThat(call("/api/items/999999/analyses?limit=0").status()).isEqualTo(404);
	}

	@Test
	void photoListIsOrderedBySeqAndNeverExposesFilePaths() throws Exception {
		Item it = newItem();
		photos.save(new ItemPhoto(it, 2, "secret/dir/2.jpg", 22L, "image/jpeg", T));
		photos.save(new ItemPhoto(it, 1, "secret/dir/1.png", 70L, "image/png", T));

		Response r = call("/api/items/" + it.getId() + "/photos");

		assertThat(r.status()).isEqualTo(200);
		assertThat(r.body().propertyNames()).containsExactly("photos");
		JsonNode list = r.body().get("photos");
		assertThat(list).hasSize(2);
		assertThat(list.get(0).get("seq").asInt()).isEqualTo(1);
		assertThat(list.get(1).get("seq").asInt()).isEqualTo(2);
		for (JsonNode photo : list) {
			assertThat(photo.propertyNames()).containsExactly("id", "itemId", "seq", "fileSize", "mimeType",
					"collectedAt");
			assertThat(photo.has("filePath")).isFalse();
			assertThat(photo.get("itemId").asLong()).isEqualTo(it.getId());
		}
		assertThat(list.get(0).get("fileSize").asLong()).isEqualTo(70L);
		assertThat(list.get(0).get("collectedAt").asString()).isEqualTo("2026-10-01T00:00:00.000Z");
		assertThat(r.body().toString()).doesNotContain("secret");
	}

	@Test
	void itemWithoutPhotosGivesEmptyList() throws Exception {
		Item it = newItem();

		assertThat(call("/api/items/" + it.getId() + "/photos").body().get("photos")).isEmpty();
	}

	@Test
	void staticSegmentsDoNotCollideWithTheIdRoute() throws Exception {
		// filter-options는 {id}로 잡히면 404(물건을 찾을 수 없습니다)가 된다.
		assertThat(call("/api/items/filter-options").status()).isEqualTo(200);
	}

}
