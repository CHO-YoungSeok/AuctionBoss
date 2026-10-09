package com.auctionboss.migration;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/** 내보내기 도구(TS)가 쓴 {@code manifest.json}. 가져오기가 읽는 필드만 담는다. */
record MigrationManifest(int ruleVersion, Map<String, Table> tables, List<Photo> photos, long orphans) {

	record Table(String file, long rows, String sha256, Long maxId, Long sqliteSeq, List<String> columns) {
	}

	record Photo(String path, long size, String sha256) {
	}

	private static final JsonMapper MAPPER = JsonMapper.builder().build();

	/** 읽을 수 없거나 모양이 다르면 값 없는 {@link ImportFailure}다. */
	static MigrationManifest read(Path file) {
		JsonNode root;
		try {
			root = MAPPER.readTree(Files.readString(file));
		}
		catch (IOException e) {
			throw new UncheckedIOException(e);
		}
		catch (RuntimeException e) {
			throw new ImportFailure("manifest.json을 해석할 수 없습니다");
		}
		try {
			Map<String, Table> tables = new LinkedHashMap<>();
			for (String name : root.path("tables").propertyNames()) {
				JsonNode t = root.path("tables").path(name);
				List<String> columns = new ArrayList<>();
				for (JsonNode c : t.path("columns")) {
					columns.add(c.stringValue());
				}
				tables.put(name, new Table(t.path("file").isString() ? t.path("file").stringValue() : null,
						t.path("rows").longValue(), t.path("sha256").stringValue(),
						t.path("maxId").isNumber() ? t.path("maxId").longValue() : null,
						t.path("sqliteSeq").isNumber() ? t.path("sqliteSeq").longValue() : null, columns));
			}
			List<Photo> photos = new ArrayList<>();
			for (JsonNode p : root.path("photos").path("files")) {
				photos.add(new Photo(p.path("path").stringValue(), p.path("size").longValue(),
						p.path("sha256").stringValue()));
			}
			return new MigrationManifest(root.path("ruleVersion").intValue(), tables, photos,
					root.path("photos").path("orphans").longValue());
		}
		catch (RuntimeException e) {
			throw new ImportFailure("manifest.json의 모양이 예상과 다릅니다");
		}
	}

}
