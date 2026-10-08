package com.auctionboss.common.error;

/** 없는 리소스. 메시지가 그대로 404 응답의 {@code error}가 된다. */
public class ResourceNotFoundException extends RuntimeException {

	public ResourceNotFoundException(String message) {
		super(message);
	}

}
