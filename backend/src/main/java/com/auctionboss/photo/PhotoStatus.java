package com.auctionboss.photo;

/** items.photo_status 값. DB에는 소문자 문자열 그대로 저장한다. */
public enum PhotoStatus {

	UNCOLLECTED("uncollected"), COLLECTED("collected"), EMPTY("empty"), FAILED("failed");

	private final String dbValue;

	PhotoStatus(String dbValue) {
		this.dbValue = dbValue;
	}

	public String dbValue() {
		return dbValue;
	}

	public static PhotoStatus fromDb(String value) {
		for (PhotoStatus s : values()) {
			if (s.dbValue.equals(value)) {
				return s;
			}
		}
		throw new IllegalArgumentException("알 수 없는 photo_status: " + value);
	}

}
