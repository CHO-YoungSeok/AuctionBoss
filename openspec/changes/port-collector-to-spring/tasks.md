## 1. 시작 기준, 픽스처 추출, 동등성 골든 생성

- [ ] 1.1 시작 기준을 확인한다. `switch-web-to-data-port`가 아카이브되었는지 보고, 게이트 5종(`npx tsc --noEmit`, `npm test`, `npm run build`, `npm run lint`, `cd backend && ./gradlew check`)이 통과하는지, TS·Java 테스트 수와 change 시작 커밋 해시를 이 파일 하단 메모에 남긴다(9장의 `workers/`·`src/lib/sources/` 무변경 확인 기준)
- [ ] 1.2 TS 동작을 실측해 design.md의 전제를 확인하고 메모에 남긴다: (a) 저장 실패 회차의 로테이션 위치(D8), (b) 같은 배치 중복 키의 이력 행과 `changed`(D6), (c) Node `fetch`가 실제로 보내는 헤더 목록(루프백 서버로 1회 캡처, D3), (d) 정규화 모델 숫자 필드의 값 범위와 소수 여부(D9), (e) 자연 키가 MySQL 콜레이션에서 충돌하는 시드 행이 있는지. 어긋나는 전제가 있으면 design.md·스펙을 고친 뒤 진행한다
- [ ] 1.3 `scripts/collector-golden/extract-fixtures.ts`를 만든다. TS 픽스처 모듈을 import해 `backend/src/test/resources/contracts/source/fixtures/*.json`으로 쓰고, 상세 응답의 이름 필드는 가림 표기로 바꾼다. vitest로 (a) 추출 JSON을 다시 읽어 원본 픽스처와 같은 값인지(가림 필드 제외), (b) 가림 대상 필드에 원문이 남지 않는지 확인한다. 변이 확인: 가림 단계를 빼면 (b)가 실패한다
- [ ] 1.4 `scripts/collector-golden/generate-source-goldens.ts`를 만든다(design.md D5: Node 루프백 서버 재생, 실제 `fetch`, 받은 요청·헤더·본문 기록, 기록용 `sleep`, 고정 `now`). D5 사례 목록 전부를 `contracts/source/*.json`으로 쓴다. vitest로 루프백 서버가 응답 순서대로 돌려주고 요청을 기록하는지, 사례마다 기존 어댑터 단위 테스트와 같은 결과(물건 수, 오류 종류)인지 확인한다. 생성을 두 번 돌려 바이트 단위로 같은지 확인한다
- [ ] 1.5 `scripts/collector-golden/generate-store-goldens.ts`를 만든다(design.md D6: 빈 임시 SQLite·사진 디렉터리, `startCollector`·`startPhotoWorker` 틱 직접 호출, 가짜 `AuctionSource`, `fixed-clock.ts`, 단계별 스냅숏). D6 시나리오 10개를 `contracts/collector/*.json`으로 쓴다. 결정성(두 번 생성 바이트 일치)과, 시나리오마다 기대한 핵심 값(예: `collect-update-change`의 신규·갱신·변경 건수, `collect-blocked`의 미저장·백오프)을 vitest로 단언한다. 변이 확인: 생성기에서 `upsert`를 건너뛰게 하면 단언이 실패한다
- [ ] 1.6 `git diff --stat <1.1 시작 커밋> -- workers/ src/lib/sources/`가 비어 있음을 확인한다(생성기는 기존 코드를 고치지 않는다)

## 2. Java 소스 어댑터

- [ ] 2.1 `collect.source`에 소스 계약(`AuctionSource`, `SourceItem`, `PhotoLookupRef`, `SourcePhoto`, 결과 record)과 오류 계층을 만든다. 오류 `kind()`가 TS 이름(`SourceRequestError`, `ResponseSchemaError`, `WafBlockedError`, `RobotDetectedError`)과 같은지, `requestsMade` 합산이 `attachPagesRequested`와 같은지 단위 테스트로 확인한다
- [ ] 2.2 `CourtAuctionHttp`를 만든다(JDK `HttpClient`, HTTP/1.1, 리다이렉트 없음, 타임아웃, 1.2(c) 헤더 집합, `Sleeper` 주입, 외부 요청 허용 검사 design.md D4). MockWebServer로 헤더·본문, 최대 동시 요청 1, 타임아웃이 `SourceRequestError`인지 확인한다. 외부 요청 허용 꺼짐에서 `http://example.invalid` 요청이 네트워크 없이 실패하는지(소켓을 열지 않음) 확인한다. 변이 확인: 루프백 검사를 지우면 이 테스트가 실패한다
- [ ] 2.3 검색·상세 응답 파서를 만든다(3단 검사 순서: `{` 시작 → `data` 객체 → `ipcheck` → 형식 검증). TS `parseSearchResponse`·`parseDetailResponse` 테스트 사례를 Java로 옮겨 같은 분류인지 확인한다. 변이 확인: `data` 객체 검사를 `ipcheck` 뒤로 옮기면 "`data` 없음은 차단이 아님" 테스트가 실패한다
- [ ] 2.4 행 접기·정규화(`RowFolder`: `toInt`, `toIntNonZero`, `text`, `toIsoDate`, `deriveStatus`, `pickAddress`, `pickMinBidPrice`, `resolveCourtCode`)와 쿠키 헤더 읽기를 옮긴다. TS 어댑터 테스트 "정규화"·"회귀" 묶음의 경계값을 Java 단위 테스트로 옮긴다
- [ ] 2.5 `CourtAuctionAdapter`(세션 부트스트랩, 페이지네이션, 법원 사이 대기, 매각기일 창, 사진 조회와 세션 재사용)를 완성하고 `SourceContractTest`(design.md D5 비교 규칙)로 어댑터 골든 전 사례를 일치시킨다. 불일치 건수와 원인을 메모에 남긴다
- [ ] 2.6 변이 확인: Java 어댑터에서 (a) 페이지 수 계산을 `groupTotalCount` 기준으로, (b) 첫 페이지 `totalYn`을 `N`으로, (c) User-Agent 한 글자, (d) 페이지 대기 5초를 4초로 하나씩 바꿔 각각 `SourceContractTest`가 실패하는지 확인하고 되돌린다

## 3. 저장과 변경 감지

- [ ] 3.1 `ItemUpsertService`를 만든다(design.md D8: 회차당 한 트랜잭션, 자연 키 사전 SELECT, `ON DUPLICATE KEY UPDATE`로 `first_seen_at` 보존, 기준점·변경 이력, 배치 시작 전 스냅숏 기준 `changed`). Testcontainers로 신규·갱신·변경 건수, 감시 대상 아닌 필드만 바뀐 갱신, null→값 변경의 `kind='change'`, 값 없는 필드 기준점 없음, 같은 배치 중복 키를 확인한다. 변이 확인: 감시 필드 숫자 비교를 문자열 비교로 바꾸면 `"1000"` vs `1000.0` 사례가 실패한다
- [ ] 3.2 원자성 테스트: 이력 INSERT에 오류를 주입해 물건 변경이 하나도 반영되지 않음을 확인한다(스펙 "이력 기록 실패"). 변이 확인: 트랜잭션 경계를 물건 단위로 바꾸면 실패한다
- [ ] 3.3 저장 시간을 잰다(법원 1곳 규모 500건 배치, 시드 위 갱신). 1초를 넘으면 JDBC 배치로 바꾸고 다시 잰다. 수치를 메모에 남긴다(design.md D8)

## 4. 로테이션, 요청 상한, 공유 백오프, 회차 본체

- [ ] 4.1 `CollectorSettings`를 만든다(`config/collector.json`의 `scope`, `intervalMs`, `photos`, 회차마다 읽기, 덮어쓰기 속성). TS `config.ts` 검증 사례(법원 0곳, 0 이하 상한, 잘못된 형식)를 옮겨 같은 거절인지 `WorkerSettingsTest` 방식으로 확인한다
- [ ] 4.2 `RotationSelector`를 옮긴다(코드로 위치 찾기, 못 찾으면 처음, 상한은 목록 길이까지). TS `rotation` 테스트 사례를 옮긴다
- [ ] 4.3 `BackoffStore`를 만든다(키 `backoff_until`, ISO 밀리초 `Z`, 한 문장 연장 design.md D8, 파싱 불가 값은 없음). Testcontainers로 짧아지지 않음, TS가 쓴 형식 읽기, 두 스레드 동시 연장 시 늦은 값 유지를 확인한다. 변이 확인: 비교 방향을 뒤집으면 "짧아지지 않음" 테스트가 실패한다
- [ ] 4.4 `WorkerRunService`에서 내부 종료 메서드를 꺼내고 건너뜀 기록(`recordSkipped`, 보관 상한 정리 포함)을 더한다. 기존 `WorkerRunApiTest`·`ScenarioContractTest`가 그대로 통과하는지와 건너뜀 행 형식(시작=종료, `error_kind`=사유)을 확인한다
- [ ] 4.5 `CollectorRun`(회차 본체: 로테이션, 법원별 호출, 요청 상한으로 다음 법원 미시작, 차단·실패 시 위치, 저장, 회차 기록 실패 무시)을 만든다. 가짜 `AuctionSource`로 TS `collector.test.ts`의 "회차 기록 연동", "로테이션 연동", "기록 실패가 수집을 막지 않는다" 사례를 옮긴다
- [ ] 4.6 `StoreContractTest`(design.md D6)로 수집 저장 골든 시나리오 7개(`collect-*`, `shared-backoff`의 수집 쪽)를 일치시킨다. 불일치 건수와 원인을 메모에 남긴다. 변이 확인: (a) 요청 상한 비교 `>=`를 `>`로, (b) 차단 시 위치를 다음 법원으로, (c) 백오프 길이를 59분으로 하나씩 바꿔 각각 골든이 실패하는지 확인한다

## 5. 스케줄러, 단일 실행 잠금, 안전장치

- [ ] 5.1 `RunLock`(전용 연결 `GET_LOCK(name, 0)`/`RELEASE_LOCK`, 연결 반환)을 만든다. Testcontainers로 두 연결 중 하나만 얻는지, 해제 후 다시 얻는지, 잠금을 쥔 연결을 강제로 닫으면 다른 연결이 얻는지(스펙 "실행 중 인스턴스 종료") 확인한다
- [ ] 5.2 `WorkerTicker`(design.md D7: 겹침 → 백오프 → 전용 스레드로 회차 넘김, `finally` 해제)를 만든다. 테스트: 회차가 주기보다 길 때 그 사이 틱이 `skipped(overlap)`로 기록되고 회차가 끝난 뒤 몰아서 실행되지 않음, 실패한 회차 뒤 다음 틱 정상, 백오프 중 `skipped(backoff)`, 백오프 확인 뒤 잠금 해제. 변이 확인: 회차를 틱 스레드에서 직접 돌리면 "몰아서 실행되지 않음" 테스트가 실패한다
- [ ] 5.3 두 인스턴스 테스트: 같은 Testcontainers MySQL에 Spring 컨텍스트 두 개(또는 `WorkerTicker` 두 벌, 각자 연결 풀)를 띄우고 같은 시각 틱을 20회 반복해 가짜 소스가 받은 동시 회차가 항상 1 이하이고 나머지는 `overlap` 건너뜀인지 확인한다. 변이 확인: 잠금 대신 메모리 플래그를 쓰면 실패한다
- [ ] 5.4 `SchedulingConfig`(조건부 빈, 기동 로그, 켜질 때 TS 워커 정지 경고)와 기본 꺼짐을 만든다. 테스트: 기본 설정 컨텍스트에 스케줄러·틱 빈이 없고 주기보다 오래 기다려도 회차 0건, 켜면 `intervalMs`로 등록, 테스트 프로필의 소스 주소가 루프백이고 외부 요청 허용이 꺼져 있음(design.md D4). 변이 확인: `matchIfMissing=true`로 바꾸면 기본 꺼짐 테스트가 실패한다
- [ ] 5.5 외부 요청 차단 통합 테스트: 외부 요청 허용 없이 소스 주소를 루프백이 아닌 주소로 두고 회차를 실행해 `failed`(`SourceRequestError`)로 기록되고 백오프가 없음을 확인한다(스펙 "외부 요청 허용 없이 실제 주소")
- [ ] 5.6 `src/__tests__/deploy-config.test.ts`에 compose·K8s가 `AUCTIONBOSS_COLLECTOR_ENABLED`, `AUCTIONBOSS_PHOTOS_ENABLED`, `AUCTIONBOSS_SOURCE_EXTERNAL_REQUESTS_ALLOWED`를 켜지 않고 TS `collector`·`photos` 서비스가 그대로 있음을 고정한다(스펙 "배포 구성", "운영 경로 유지")
- [ ] 5.7 종료 처리: 애플리케이션 종료 시 진행 중 회차를 기다리고 잠금을 푸는지, 대기 상한을 넘으면 로그를 남기고 끝나는지 테스트한다

## 6. 사진 워커

- [ ] 6.1 `PendingPhotoQuery`를 옮긴다(design.md D10). Testcontainers로 식별자 없는 물건 제외, 미시도 우선, 실패 1시간 전 제외·25시간 전 포함, `photo_attempted_at ASC, id DESC` 정렬을 확인한다
- [ ] 6.2 `PhotoFileWriter`를 만든다(`{itemId}/{seq}{ext}`, 매직 바이트 MIME, GIF 87a·89a, 10MB 상한, 경계 검사). 단위 테스트로 형식별 확장자, 상한 초과 거절, 디렉터리 밖 경로 거절을 확인하고, 저장한 파일을 기존 사진 파일 API로 같은 바이트로 내려받는지 통합 테스트한다(스펙 "사진 회차와 파일 저장")
- [ ] 6.3 `PhotoRun`(회차마다 새 어댑터, 물건 사이 대기, 요청 직전 백오프 재확인, 식별자 없으면 건너뜀, 차단 시 물건을 실패로 안 적고 백오프·중단, 결과 규칙)과 사진 틱을 만든다. TS `photos.test.ts`의 "회차 결과와 수치", "차단과 공유 백오프", "겹침과 기록 실패" 사례를 옮긴다
- [ ] 6.4 `StoreContractTest`로 사진 저장 골든(`photos-outcomes`, `photos-blocked-and-retry`, `shared-backoff`의 사진 쪽)을 사진 파일 SHA-256까지 일치시킨다. 변이 확인: 차단된 물건을 `failed`로 기록하게 바꾸면 골든이 실패한다

## 7. 아키텍처 테스트

- [ ] 7.1 ArchUnit 의존성을 더하고 design.md D12 규칙 4개를 `CollectArchitectureTest`로 만든다. `./gradlew check`에서 돈다
- [ ] 7.2 소스 고유 필드명 누출 테스트를 만든다(어댑터 응답 record에서 필드명 목록을 모아 `backend/src/main/java`의 어댑터 패키지 밖 파일에서 찾는다)
- [ ] 7.3 변이 확인: (a) `CollectorRun`이 `CourtAuctionAdapter`를 직접 참조, (b) 어댑터가 `ItemRepository` 참조, (c) `collector` 패키지에서 `java.net.http` 사용, (d) 어댑터 밖 코드에 `"ipcheck"` 문자열을 하나씩 넣어 각각 테스트가 실패하는지 확인하고 되돌린다. 결과를 메모에 남긴다

## 8. 개발 환경 검증

- [ ] 8.1 `scripts/dev/verify-collector-on-spring.sh`를 만든다(design.md D13 가짜 서버 전체 경로: compose MySQL, 루프백 가짜 소스 서버, 스케줄러 켬·짧은 주기·외부 요청 허용 꺼짐, 비밀 값 출력 금지). 1회 실행해 수집 3회·사진 1회의 회차 기록, `GET /api/items` 반영, 사진 파일 API를 확인하고, Spring 인스턴스 2개로 `overlap` 건너뜀과 겹침 0을 확인한다. 가짜 서버 밖으로 나간 연결이 없었음을 Spring 로그(요청 대상 호스트)로 확인한다
- [ ] 8.2 `RunOnceRunner`(design.md D11: 웹 서버 없이 틱 하나, 종료 코드, 1회 실행용 덮어쓰기)를 만들고 가짜 서버로 수집·사진 각 1회를 실행해 받은 요청이 각 2개인지 확인한다
- [ ] 8.3 `scripts/collector-golden/compare-live.ts`(읽기 전용, 자연 키로 Spring 확인용 DB와 TS SQLite의 같은 물건 정규화 컬럼 비교, 건수만 출력)와 `scripts/dev/live-check-collector.sh`(design.md D13 절차 1~7, 사전 확인 실패 시 중단)를 만든다. 가짜 서버와 임시 SQLite로 스크립트를 먼저 돌려 본다
- [ ] 8.4 **사람이 한 번만** 실제 사이트 최소 확인을 실행한다: TS `collector`·`photos` 정지와 백오프·직전 회차 시각 확인 → 빈 확인용 DB로 수집 1회(요청 2) → 60초 이상 대기 → 사진 1회(요청 2) → 회차 기록·요청 수·사진 확인 → TS SQLite와 비교 → TS 워커 재개(차단 시 1시간 뒤) → 확인용 DB·사진 디렉터리 삭제. 요청 수, 소요 시간, 비교 불일치 건수만 메모에 남긴다(실데이터 값·개인 정보는 남기지 않음)

## 9. 마무리

- [ ] 9.1 게이트 5종을 모두 통과시킨다. TS·Java 테스트 수가 1.1보다 줄지 않았는지 확인하고, 줄었으면 이유를 보고한다. `git diff --stat <1.1 시작 커밋> -- workers/ src/lib/sources/`가 비어 있는지 확인한다
- [ ] 9.2 수치를 `docs/DEVELOPMENT_NOTES.md`에 기록한다: 어댑터 골든 사례 수·저장 골든 시나리오·단계 수와 불일치 원인, 의도된 차이(타임아웃, 오류 메시지 첫 줄 비교), 회차 저장 시간, 두 인스턴스 잠금 결과, 8.1·8.4 결과, 테스트 수 변화
- [ ] 9.3 `docs/REFERENCE.md`와 README에 수집 설정(`auctionboss.collector.*`, `auctionboss.photos.*`, `auctionboss.source.*`), 기본 꺼짐 두 겹, 1회 실행 모드, 동시 운영 금지와 5단계 런북 초안(design.md D14)을 반영한다
- [ ] 9.4 `docs/ROADMAP.md` 4단계를 갱신한다: 완료 기준 해석(design.md D14: 저장 골든 전 시나리오 일치, 두 인스턴스 잠금 테스트), 운영 전환과 TS 수집기·사진 워커 은퇴를 5단계 할 일에 적고, 상태·수치·기록 위치를 채운다
- [ ] 9.5 `regression-verifier` 서브에이전트로 회귀 검증을 받고 지적 사항을 반영한다(특히 "외부 요청이 테스트에서 나갈 수 있는 경로"와 "TS·Java 동작이 다시 갈라졌을 때 잡는 테스트")
- [ ] 9.6 커밋하고 푸시한 뒤 GitHub Actions의 TS 잡과 Java 잡이 통과하는지 확인한다
- [ ] 9.7 `openspec validate port-collector-to-spring --strict`를 통과시킨 뒤 change를 아카이브하고(`switch-web-to-data-port` 아카이브 뒤), 메인 스펙 `spring-backend`에 요구사항이 반영됐는지 확인한다

---

### 메모
<!-- 1.1 시작 커밋·테스트 수, 1.2 전제 실측, 2.5·4.6 불일치 원인, 3.3 저장 시간, 7.3 변이 결과, 8.4 실제 사이트 확인 결과를 여기에 남긴다 -->
