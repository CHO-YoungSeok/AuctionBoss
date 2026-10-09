package com.auctionboss.collect.photos;

import java.time.Instant;
import java.time.LocalDateTime;
import java.time.ZoneOffset;
import java.util.List;

import com.auctionboss.photo.PhotoStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/** 사진 저장의 DB 쪽(TS {@code saveItemPhotos}·{@code updateItemPhotoStatus}). 물건 하나가 쓰기 트랜잭션 하나다. */
@Service
public class PhotoSaveService {

	/** 저장된 사진 파일 한 장의 메타데이터. */
	public record SavedPhoto(long seq, String filePath, long fileSize, String mimeType) {
	}

	private final JdbcTemplate jdbc;

	PhotoSaveService(JdbcTemplate jdbc) {
		this.jdbc = jdbc;
	}

	/** {@code item_photos}를 (물건, 순번)으로 갱신·삽입하고 물건의 상태를 {@code collected}로, 시도·수집 시각을 {@code now}로 한다. */
	@Transactional
	public void saveCollected(long itemId, List<SavedPhoto> photos, Instant now) {
		LocalDateTime at = utc(now);
		for (SavedPhoto photo : photos) {
			jdbc.update("""
					INSERT INTO item_photos (item_id, seq, file_path, file_size, mime_type, collected_at)
					VALUES (?, ?, ?, ?, ?, ?) AS new
					ON DUPLICATE KEY UPDATE file_path = new.file_path, file_size = new.file_size,
					  mime_type = new.mime_type, collected_at = new.collected_at""", itemId, photo.seq(),
					photo.filePath(), photo.fileSize(), photo.mimeType(), at);
		}
		jdbc.update("""
				UPDATE items SET photo_status = ?, photo_count = ?, photo_collected_at = ?, photo_attempted_at = ?
				WHERE id = ?""", PhotoStatus.COLLECTED.dbValue(), photos.size(), at, at, itemId);
	}

	/** 상태와 마지막 시도 시각을 기록한다({@code empty}·{@code failed}). */
	@Transactional
	public void markStatus(long itemId, PhotoStatus status, Instant now) {
		jdbc.update("UPDATE items SET photo_status = ?, photo_attempted_at = ? WHERE id = ?", status.dbValue(),
				utc(now), itemId);
	}

	private static LocalDateTime utc(Instant instant) {
		return LocalDateTime.ofInstant(instant, ZoneOffset.UTC);
	}

}
