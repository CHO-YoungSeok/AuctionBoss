package com.auctionboss.migration;

import static com.tngtech.archunit.lang.syntax.ArchRuleDefinition.noClasses;

import com.tngtech.archunit.core.importer.ImportOption;
import com.tngtech.archunit.junit.AnalyzeClasses;
import com.tngtech.archunit.junit.ArchTest;
import com.tngtech.archunit.lang.ArchRule;

/**
 * 이전 도구 패키지({@code com.auctionboss.migration}) 경계. 이전 도구는 수집·도메인 패키지를 읽기만 하는 끝점이다: 아무도 이 패키지에 의존하지 않으므로
 * {@code collect} 아래 패키지 순환 금지 규칙({@code CollectArchitectureTest})에도 끼어들지 않는다. 소스 어댑터 격리·스케줄링·HTTP 클라이언트 규칙은 그
 * 파일의 규칙이 이 패키지에도 똑같이 적용한다(어댑터와 스케줄링 패키지를 쓰지 못한다).
 */
@AnalyzeClasses(packages = "com.auctionboss", importOptions = ImportOption.DoNotIncludeTests.class)
class MigrationArchitectureTest {

	@ArchTest
	static final ArchRule 아무도_이전_도구_패키지에_의존하지_않는다 = noClasses().that()
		.resideOutsideOfPackage("..migration..")
		.should()
		.dependOnClassesThat()
		.resideInAPackage("..migration..")
		.because("이전 도구는 끝점이다. 수집·화면 코드가 가져오기에 기대면 안 된다");

	@ArchTest
	static final ArchRule 이전_도구는_소스_어댑터와_HTTP_클라이언트를_쓰지_않는다 = noClasses().that()
		.resideInAPackage("..migration..")
		.should()
		.dependOnClassesThat()
		.resideInAnyPackage("..collect.source..", "java.net.http..", "org.springframework.web.client..")
		.because("이전은 외부 소스에 요청하지 않는다");

}
