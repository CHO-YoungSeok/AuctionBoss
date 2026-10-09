package com.auctionboss.collect.source.courtauction;

import static org.assertj.core.api.Assertions.assertThat;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.lang.reflect.RecordComponent;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.TreeSet;
import java.util.regex.Pattern;
import java.util.stream.Stream;

import com.auctionboss.collect.source.SourceItem;
import org.junit.jupiter.api.Test;

/**
 * 7.2: 소스 고유 필드명 누출. ArchUnit은 문자열 상수를 보지 못하므로 어댑터 패키지 밖 메인 소스 파일에 소스 필드명이 나타나는지 직접
 * 찾는다. 필드명 목록은 어댑터 응답 record의 컴포넌트 이름에서 자동으로 모으고, record가 아닌 봉투·요청 키는 아래 목록으로 더한다(목록이
 * 어댑터 소스에서 사라지면 그 항목이 낡았다는 뜻이라 따로 실패한다).
 */
class SourceFieldLeakTest {

	private static final Path MAIN = Path.of("src/main/java");

	private static final Path ADAPTER_DIR = MAIN.resolve("com/auctionboss/collect/source/courtauction");

	/** 이름이 소스 응답에서 온 것이 아니라 어댑터 내부 용어인 record 컴포넌트. */
	private static final Set<String> NOT_SOURCE_NAMES = Set.of("seq", "rows");

	/** record가 아닌 곳(봉투, 요청 본문, 상세 응답)에서 읽는 소스 고유 키. */
	private static final List<String> WIRE_NAMES = List.of("dlt_srchResult", "dma_pageInfo", "ipcheck", "csPicLst",
			"cortOfcCd", "dma_srchGdsDtlSrch", "dma_srchGdsDtlSrchInfo", "dma_result", "cortAuctnPicSeq");

	private static final List<Class<?>> ADAPTER_RECORDS = List.of(SearchRow.class, SearchPage.class, DetailPic.class);

	/** 정규화 모델({@code SourceItem})이 같은 이름을 쓰는 필드(예: minArea, maxArea)는 소스 고유 이름이 아니라 모델 이름이다. */
	private static Set<String> normalizedModelNames() {
		Set<String> names = new TreeSet<>();
		for (RecordComponent component : SourceItem.class.getRecordComponents()) {
			names.add(component.getName());
		}
		return names;
	}

	static Set<String> sourceFieldNames() {
		Set<String> modelNames = normalizedModelNames();
		Set<String> names = new TreeSet<>();
		for (Class<?> type : ADAPTER_RECORDS) {
			for (RecordComponent component : type.getRecordComponents()) {
				if (!NOT_SOURCE_NAMES.contains(component.getName()) && !modelNames.contains(component.getName())) {
					names.add(component.getName());
				}
			}
		}
		names.addAll(WIRE_NAMES);
		return names;
	}

	private static List<Path> javaFiles(Path root) {
		try (Stream<Path> walk = Files.walk(root)) {
			return walk.filter(p -> p.toString().endsWith(".java")).toList();
		}
		catch (IOException e) {
			throw new UncheckedIOException(e);
		}
	}

	private static String read(Path path) {
		try {
			return Files.readString(path);
		}
		catch (IOException e) {
			throw new UncheckedIOException(e);
		}
	}

	private static Pattern word(String name) {
		return Pattern.compile("(?<![A-Za-z0-9_])" + Pattern.quote(name) + "(?![A-Za-z0-9_])");
	}

	/** 어댑터 패키지 밖 메인 소스 중 소스 필드명이 나오는 곳({@code 파일: 이름}). */
	static List<String> leaks(Path mainRoot, Path adapterDir, Set<String> names) {
		List<String> found = new ArrayList<>();
		for (Path file : javaFiles(mainRoot)) {
			if (file.startsWith(adapterDir)) {
				continue;
			}
			String text = read(file);
			for (String name : names) {
				if (word(name).matcher(text).find()) {
					found.add(mainRoot.relativize(file) + ": " + name);
				}
			}
		}
		return found;
	}

	@Test
	void 필드명_목록은_비어_있지_않고_어댑터_소스에_실제로_있다() {
		Set<String> names = sourceFieldNames();
		assertThat(names).doesNotContain("minArea", "maxArea");
		assertThat(names).contains("srnSaNo", "maemulSer", "picFile", "jiwonNm", "dlt_srchResult", "ipcheck");

		String adapterText = String.join("\n", javaFiles(ADAPTER_DIR).stream().map(SourceFieldLeakTest::read).toList());
		// record 컴포넌트는 FieldReader가 문자열로 읽으므로 어댑터 안에서 이름이 문자열로 나온다.
		assertThat(names).filteredOn(n -> !word(n).matcher(adapterText).find()).as("어댑터 소스에 없는 낡은 목록 항목").isEmpty();
	}

	@Test
	void 어댑터_패키지_밖_메인_소스에는_소스_필드명이_나오지_않는다() {
		assertThat(leaks(MAIN, ADAPTER_DIR, sourceFieldNames())).isEmpty();
	}

	@Test
	void 찾는_방식은_어댑터_밖의_문자열_상수를_실제로_잡는다(@org.junit.jupiter.api.io.TempDir Path temp) throws IOException {
		Path outside = temp.resolve("com/auctionboss/other/Leaky.java");
		Files.createDirectories(outside.getParent());
		Files.writeString(outside, "class Leaky { String k = \"ipcheck\"; }");
		Path inside = temp.resolve("com/auctionboss/collect/source/courtauction/Ok.java");
		Files.createDirectories(inside.getParent());
		Files.writeString(inside, "class Ok { String k = \"ipcheck\"; }");

		assertThat(leaks(temp, temp.resolve("com/auctionboss/collect/source/courtauction"), Set.of("ipcheck")))
			.containsExactly("com/auctionboss/other/Leaky.java: ipcheck");
	}

}
