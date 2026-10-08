package com.auctionboss.common.error;

import java.util.List;

import com.fasterxml.jackson.annotation.JsonInclude;

/** 오류 응답 본문. {@code details}는 없으면 생략한다. */
public record ApiErrorResponse(String error, @JsonInclude(JsonInclude.Include.NON_NULL) List<FieldIssue> details) {

	public static ApiErrorResponse of(String error) {
		return new ApiErrorResponse(error, null);
	}

}
