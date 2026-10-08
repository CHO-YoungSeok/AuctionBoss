package com.auctionboss.item;

import com.auctionboss.common.error.ResourceNotFoundException;

public class ItemNotFoundException extends ResourceNotFoundException {

	/** {@code id}는 URL 경로의 원문이다(숫자가 아니어도 같은 메시지를 쓴다). */
	public ItemNotFoundException(String id) {
		super("물건을 찾을 수 없습니다: id=" + id);
	}

}
