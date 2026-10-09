package com.auctionboss.migration;

import java.time.Instant;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;

import com.auctionboss.collect.collector.RotationStore;
import com.auctionboss.collect.run.BackoffStore;

/**
 * 롤백 때 되쓸 상태(design D11): 차단 백오프 종료 시각과 로테이션 위치. 값은 시각과 법원 코드뿐이다. 키가 없으면(또는 백오프 값을 읽을 수
 * 없으면) {@code null}이다. 출력은 한 줄 JSON이다:
 * {@code {"backoffUntil":"2026-10-09T01:02:03.456Z"|null,"rotationNextCourtCode":"B000210"|null}}.
 */
public final class StateExporter {

	private static final DateTimeFormatter ISO_MILLIS = DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'")
		.withZone(ZoneOffset.UTC);

	private final BackoffStore backoff;

	private final RotationStore rotation;

	StateExporter(BackoffStore backoff, RotationStore rotation) {
		this.backoff = backoff;
		this.rotation = rotation;
	}

	public String export() {
		Instant until = backoff.until().orElse(null);
		String court = rotation.get();
		StringBuilder out = new StringBuilder("{\"backoffUntil\":");
		if (until == null) {
			out.append("null");
		}
		else {
			RowNormalizer.quote(ISO_MILLIS.format(until), out);
		}
		out.append(",\"rotationNextCourtCode\":");
		if (court == null) {
			out.append("null");
		}
		else {
			RowNormalizer.quote(court, out);
		}
		return out.append('}').toString();
	}

}
