package com.auctionboss.collect.source;

/** 사진 한 장. 이미지 바이트의 표준 텍스트 표현(base64)이라 소스 고유 형식이 아니다. */
public record SourcePhoto(long seq, String base64) {
}
