package com.auctionboss.migration;

import java.util.ArrayList;
import java.util.List;

/** 가져오기 결과 보고. 줄에는 테이블 이름, 건수, 해시, 시간, 컬럼 이름만 들어간다(값 없음). */
public final class ImportReport {

	private final List<String> lines = new ArrayList<>();

	private boolean success;

	void line(String format, Object... args) {
		lines.add(args.length == 0 ? format : String.format(format, args));
	}

	void succeeded() {
		success = true;
	}

	public boolean success() {
		return success;
	}

	public List<String> lines() {
		return List.copyOf(lines);
	}

	public String text() {
		return String.join("\n", lines);
	}

}
