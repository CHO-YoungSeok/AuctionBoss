package com.auctionboss.worker;

import com.auctionboss.common.error.ResourceNotFoundException;

public class WorkerRunNotFoundException extends ResourceNotFoundException {

	/** {@code id}는 URL 경로의 원문이거나 JS 숫자 표기다. */
	public WorkerRunNotFoundException(String id) {
		super("회차를 찾을 수 없습니다: id=" + id);
	}

}
