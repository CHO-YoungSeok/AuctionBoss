package com.auctionboss.worker;

/** worker_runs.outcome 값. */
public enum RunOutcome {

	RUNNING("running"), SUCCESS("success"), FAILED("failed"), BLOCKED("blocked"), SKIPPED("skipped");

	private final String dbValue;

	RunOutcome(String dbValue) {
		this.dbValue = dbValue;
	}

	public String dbValue() {
		return dbValue;
	}

	public static RunOutcome fromDb(String value) {
		for (RunOutcome o : values()) {
			if (o.dbValue.equals(value)) {
				return o;
			}
		}
		throw new IllegalArgumentException("알 수 없는 outcome: " + value);
	}

}
