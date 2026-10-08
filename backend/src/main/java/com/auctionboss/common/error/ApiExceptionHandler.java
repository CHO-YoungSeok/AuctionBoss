package com.auctionboss.common.error;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.http.HttpStatusCode;
import org.springframework.http.ResponseEntity;
import org.springframework.web.ErrorResponse;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;

/** 오류를 원본 API와 같은 {@code { error, details? }} 형태로 바꾼다. */
@RestControllerAdvice
public class ApiExceptionHandler {

	private static final Logger log = LoggerFactory.getLogger(ApiExceptionHandler.class);

	@ExceptionHandler(InvalidRequestException.class)
	ResponseEntity<ApiErrorResponse> invalidRequest(InvalidRequestException e) {
		return ResponseEntity.badRequest().body(new ApiErrorResponse(e.getMessage(), e.getIssues()));
	}

	@ExceptionHandler(ResourceNotFoundException.class)
	ResponseEntity<ApiErrorResponse> notFound(ResourceNotFoundException e) {
		return ResponseEntity.status(HttpStatus.NOT_FOUND).body(ApiErrorResponse.of(e.getMessage()));
	}

	@ExceptionHandler(Exception.class)
	ResponseEntity<ApiErrorResponse> unexpected(Exception e) {
		// 405, 404(매핑 없음) 같은 Spring MVC의 상태 코드 예외는 500으로 뭉개지 않고 그대로 낸다.
		if (e instanceof ErrorResponse mvc) {
			HttpStatusCode status = mvc.getStatusCode();
			String detail = mvc.getBody().getDetail();
			return ResponseEntity.status(status).body(ApiErrorResponse.of(detail != null ? detail : status.toString()));
		}
		log.error("처리되지 않은 예외", e);
		return ResponseEntity.internalServerError().body(ApiErrorResponse.of("요청을 처리하지 못했습니다"));
	}

}
