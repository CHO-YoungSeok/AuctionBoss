package com.auctionboss.common.error;

import java.sql.SQLException;

/** 외래 키 위반(MySQL 1452: 부모 행이 없다) 판별. */
public final class ForeignKeyViolations {

	private static final int ER_NO_REFERENCED_ROW_2 = 1452;

	private ForeignKeyViolations() {
	}

	public static boolean isMissingParent(Throwable error) {
		for (Throwable t = error; t != null; t = t.getCause()) {
			if (t instanceof SQLException sql && sql.getErrorCode() == ER_NO_REFERENCED_ROW_2) {
				return true;
			}
			if (t.getCause() == t) {
				break;
			}
		}
		return false;
	}

}
