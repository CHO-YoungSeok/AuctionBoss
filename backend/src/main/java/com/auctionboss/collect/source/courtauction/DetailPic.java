package com.auctionboss.collect.source.courtauction;

/** 상세 응답의 사진 항목 중 쓰는 필드: 순번과 base64 이미지. */
record DetailPic(Numericish seq, String picFile) {
}
