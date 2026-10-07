package com.auctionboss.history;

/** item_changes.kind 값: 최초 저장의 기준점인지, 실제 변경인지. */
public enum ChangeKind {

	BASELINE("baseline"), CHANGE("change");

	private final String dbValue;

	ChangeKind(String dbValue) {
		this.dbValue = dbValue;
	}

	public String dbValue() {
		return dbValue;
	}

	public static ChangeKind fromDb(String value) {
		for (ChangeKind k : values()) {
			if (k.dbValue.equals(value)) {
				return k;
			}
		}
		throw new IllegalArgumentException("알 수 없는 kind: " + value);
	}

}
