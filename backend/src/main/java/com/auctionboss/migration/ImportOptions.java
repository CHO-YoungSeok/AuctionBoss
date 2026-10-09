package com.auctionboss.migration;

import java.nio.file.Path;

/**
 * 가져오기 설정. {@code dir}은 내보내기 결과({@code manifest.json}, {@code NN_<table>.sql}, {@code photos/})가 있는 디렉터리,
 * {@code replace}는 대상 데이터를 지우고 다시 적재할지, {@code dryRun}은 끝까지 돌린 뒤 롤백할지다.
 */
public record ImportOptions(Path dir, boolean replace, boolean dryRun) {
}
