package com.auctionboss.collect;

import static com.tngtech.archunit.lang.syntax.ArchRuleDefinition.noClasses;
import static com.tngtech.archunit.library.dependencies.SlicesRuleDefinition.slices;

import com.tngtech.archunit.core.importer.ImportOption;
import com.tngtech.archunit.junit.AnalyzeClasses;
import com.tngtech.archunit.junit.ArchTest;
import com.tngtech.archunit.lang.ArchRule;

/**
 * 7.1: 수집 패키지 경계(design D12). 메인 클래스만 본다(테스트 클래스는 제외).
 *
 * <ul>
 * <li>소스 고유 형식은 어댑터 패키지({@code collect.source.courtauction}) 안에 갇힌다: 밖에서는 {@code AuctionSource}와 정규화
 * 모델({@code collect.source})만 본다.</li>
 * <li>소스 패키지는 저장소(JPA, JDBC, Spring Data)와 도메인 패키지를 모른다.</li>
 * <li>HTTP 클라이언트는 어댑터에서만, 스케줄링은 {@code collect.run}에서만 쓴다.</li>
 * <li>{@code collect} 아래 패키지끼리 순환하지 않는다(5장: {@code run}이 {@code collector}·{@code photos}를 참조하지 않고 함수형
 * 인터페이스로 주입받는 구조를 지킨다).</li>
 * </ul>
 */
@AnalyzeClasses(packages = "com.auctionboss", importOptions = ImportOption.DoNotIncludeTests.class)
class CollectArchitectureTest {

	private static final String ADAPTER = "..collect.source.courtauction..";

	@ArchTest
	static final ArchRule 어댑터_밖은_어댑터_패키지에_의존하지_않는다 = noClasses().that()
		.resideOutsideOfPackage(ADAPTER)
		.should()
		.dependOnClassesThat()
		.resideInAPackage(ADAPTER)
		.because("소스 고유 형식이 어댑터 밖으로 새면 안 된다. 빈 생성은 어댑터 패키지 안 CourtAuctionConfig가 한다");

	@ArchTest
	static final ArchRule 소스_패키지는_저장소와_도메인을_모른다 = noClasses().that()
		.resideInAPackage("..collect.source..")
		.should()
		.dependOnClassesThat()
		.resideInAnyPackage("jakarta.persistence..", "org.springframework.jdbc..", "org.springframework.data..",
				"com.auctionboss.item..", "com.auctionboss.worker..", "com.auctionboss.photo..")
		.because("소스는 DB와 도메인에 의존하지 않고 정규화 모델만 돌려준다");

	@ArchTest
	static final ArchRule HTTP_클라이언트는_어댑터에서만_쓴다 = noClasses().that()
		.resideOutsideOfPackage(ADAPTER)
		.should()
		.dependOnClassesThat()
		.resideInAPackage("java.net.http..")
		.because("외부 요청은 어댑터의 외부 요청 허용 검사를 지나야 한다");

	@ArchTest
	static final ArchRule 스케줄링은_run_패키지에서만_쓴다 = noClasses().that()
		.resideOutsideOfPackage("..collect.run..")
		.should()
		.dependOnClassesThat()
		.resideInAPackage("org.springframework.scheduling..")
		.because("@Scheduled, TaskScheduler는 기본 꺼짐 조건을 가진 collect.run의 스케줄링 설정만 쓴다");

	@ArchTest
	static final ArchRule collect_아래_패키지는_순환하지_않는다 = slices().matching("com.auctionboss.collect.(*)..")
		.should()
		.beFreeOfCycles();

}
