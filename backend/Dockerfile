# 빌드 스테이지: JDK 21 + Gradle wrapper
FROM eclipse-temurin:21-jdk AS build
WORKDIR /workspace

# 의존성 레이어 캐시: 빌드 스크립트와 wrapper를 먼저 복사해 의존성만 내려받는다.
COPY gradlew settings.gradle.kts build.gradle.kts ./
COPY gradle ./gradle
RUN chmod +x gradlew && ./gradlew --no-daemon dependencies > /dev/null

COPY src ./src
# 테스트는 CI가 담당하므로 이미지 빌드에서는 돌리지 않는다.
RUN ./gradlew --no-daemon bootJar -x test \
    && java -Djarmode=tools -jar build/libs/backend-0.0.1-SNAPSHOT.jar extract --layers --destination /workspace/extracted

# 런타임 스테이지: JRE 21, 비루트 사용자
FROM eclipse-temurin:21-jre
RUN apt-get update && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 --no-create-home app
WORKDIR /app
# 사진 디렉터리(auctionboss.photos.dir). 빈 named volume은 이미지 디렉터리의 소유권을 물려받으므로
# 비루트 사용자 app(10001)이 쓸 수 있게 미리 만들어 둔다(migrate-data-and-cutover D8).
RUN mkdir -p /app/photos && chown 10001:10001 /app/photos
COPY --from=build /workspace/extracted/dependencies/ ./
COPY --from=build /workspace/extracted/spring-boot-loader/ ./
COPY --from=build /workspace/extracted/snapshot-dependencies/ ./
COPY --from=build /workspace/extracted/application/ ./
USER app
EXPOSE 8080
ENTRYPOINT ["java", "-jar", "backend-0.0.1-SNAPSHOT.jar"]
