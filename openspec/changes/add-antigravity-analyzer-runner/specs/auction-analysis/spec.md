## MODIFIED Requirements

### Requirement: Claude 분석 실행
분석 워커는 물건 데이터를 입력으로 Claude 분석을 실행해 결과를 얻어야 한다(SHALL). 분석 결과에는 최소한 요약 평가 텍스트와 감정가 대비 최저매각가격 비율에 대한 코멘트가 포함되어야 한다(SHALL). 개별 물건의 분석 실패는 다른 물건의 분석을 중단시켜서는 안 된다(MUST NOT).

분석 실행 방식은 로컬 headless Claude CLI(`claude -p`), Anthropic Messages API 직접 호출, 로컬 headless Antigravity CLI(`agy -p`)를 모두 지원해야 한다(SHALL). 실행 방식은 다음 순서로 정해져야 한다(SHALL):

1. `AUCTIONBOSS_ANALYZER_RUNNER`가 `agy`이면 Antigravity CLI를 사용한다(`ANTHROPIC_API_KEY` 유무와 무관).
2. 값이 없거나 `claude`이면 `ANTHROPIC_API_KEY`로 정한다: 값이 설정되어 있으면 Messages API를 사용하고, 설정되어 있지 않으면 로컬 Claude CLI를 사용한다.
3. 그 밖의 값이면 워커는 분석을 시작하지 않고 즉시 실패해야 한다(MUST) — 오타로 의도와 다른 실행기가 조용히 쓰여서는 안 된다.

컨테이너나 서버 환경에서 CLI 바이너리가 없더라도 유효한 API 키가 설정되어 있으면 분석이 정상 동작해야 한다(SHALL).

Antigravity CLI 실행은 저장소·사용자 작업 디렉터리가 아닌 빈 임시 디렉터리에서, 샌드박스 모드로, 도구 권한 자동 승인 없이 실행해야 한다(MUST) — 분석은 순수 텍스트 작업이며, 물건 데이터에 섞인 문구가 명령 실행으로 이어져서는 안 된다(MUST NOT). 응답 봉투의 상태가 성공이 아니거나, 응답 텍스트가 비었거나, 거부된 도구 요청이 있으면 그 물건의 분석은 실패로 처리해야 한다(SHALL). 시간 상한은 워커가 프로세스를 종료해 지켜야 하며(SHALL), 시간 초과는 실패다. Antigravity 실행기의 기본 모델은 Gemini Flash(`gemini-3.8-flash-medium`)이고 `AUCTIONBOSS_ANALYZE_MODEL`로 덮어쓸 수 있어야 한다(SHALL). 저장되는 분석의 모델 값은 실행 경로를 구별할 수 있도록 `agy:<모델 id>` 형식이어야 한다(SHALL).

분석 입력에는 수집된 확장 필드(면적, 차수별 최저매각가격, 용도 분류, 구조화된 소재지, 사건 비고 등)가 포함되어야 한다(SHALL). 프롬프트는 이 정보로 가능해진 판단 — 면적당 가격, 차수별 저감 추이, 일괄매각 여부가 갖는 의미 — 을 다루어야 한다(SHALL).

값이 없는 필드에 대해 추측해서는 안 된다(MUST NOT). 특히 이 소스로는 **권리관계·임차인·등기 정보를 얻을 수 없으므로**(확인된 사실), 분석 결과는 그 한계를 명시하고 권리분석·현장조사가 필요함을 알려야 한다(SHALL).

분석 입력이나 프롬프트가 바뀌면 프롬프트 버전을 올려야 한다(MUST) — 버전이 그대로면 기존 분석이 낡은 입력으로 생성된 것인지 구별할 수 없다.

#### Scenario: 정상 분석
- **WHEN** 미분석 물건 1건에 대해 분석이 실행되면
- **THEN** Claude 엔진이 물건 데이터를 입력으로 실행되고, 구조화된 분석 결과(요약 평가 포함)가 생성된다

#### Scenario: Direct API 모드 분석
- **WHEN** `ANTHROPIC_API_KEY`가 주어지고 워커가 실행되면
- **THEN** CLI 바이너리 없이도 Anthropic Messages API를 직접 호출하여 분석 결과를 획득한다

#### Scenario: API 키가 있으면 API를 우선 사용
- **WHEN** `ANTHROPIC_API_KEY`가 설정되어 있고 로컬 CLI도 설치된 환경에서 실행기 변수 없이 분석이 실행되면
- **THEN** Messages API로 분석하고 로컬 CLI는 호출하지 않는다

#### Scenario: API 키가 없으면 로컬 CLI 사용
- **WHEN** `ANTHROPIC_API_KEY`가 설정되지 않은 환경에서 실행기 변수 없이 분석이 실행되면
- **THEN** 로컬 headless Claude CLI로 분석하고 Messages API는 호출하지 않는다

#### Scenario: Antigravity 실행기 선택
- **WHEN** `AUCTIONBOSS_ANALYZER_RUNNER=agy`이고 `ANTHROPIC_API_KEY`도 설정된 환경에서 분석이 실행되면
- **THEN** Antigravity CLI로 분석하고 Messages API와 Claude CLI는 호출하지 않는다

#### Scenario: 알 수 없는 실행기 값
- **WHEN** `AUCTIONBOSS_ANALYZER_RUNNER`가 `claude`·`agy`가 아닌 값이면
- **THEN** 워커는 분석 요청을 하나도 보내지 않고 원인을 알리며 종료한다

#### Scenario: Antigravity 기본 모델과 기록
- **WHEN** Antigravity 실행기로 `AUCTIONBOSS_ANALYZE_MODEL` 없이 분석이 성공하면
- **THEN** `gemini-3.8-flash-medium` 모델로 실행되고, 저장된 분석의 모델 값은 `agy:gemini-3.8-flash-medium`이다

#### Scenario: Antigravity 격리 실행
- **WHEN** Antigravity 실행기가 물건 1건을 분석하면
- **THEN** 빈 임시 디렉터리에서 샌드박스 모드로, 도구 권한 자동 승인 옵션 없이 실행되고, 끝나면 임시 디렉터리는 지워진다

#### Scenario: 거부된 도구 요청
- **WHEN** Antigravity 응답이 성공 상태이지만 거부된 도구 요청을 담고 있으면
- **THEN** 그 물건의 분석은 실패로 처리되고 결과는 저장되지 않는다

#### Scenario: 빈 응답 또는 오류 상태
- **WHEN** Antigravity 응답의 상태가 오류이거나 응답 텍스트가 비어 있으면
- **THEN** 그 물건의 분석은 실패로 처리되고, 오류 문구가 실패 분류의 진단으로 쓰인다

#### Scenario: Antigravity 장애성 오류
- **WHEN** Antigravity 실행이 로그인 만료·할당량 초과·잘못된 모델 선택처럼 다음 물건도 같은 이유로 실패할 오류를 내면
- **THEN** 그 회차의 남은 분석을 중단하고, 그 물건에 실패 쿨다운을 걸지 않는다

#### Scenario: 프롬프트 크기 상한
- **WHEN** Antigravity 실행기로 넘길 프롬프트가 상한(100 KiB)을 넘으면
- **THEN** 프로세스를 띄우지 않고 그 물건의 분석만 실패로 처리한다

#### Scenario: 개별 분석 실패
- **WHEN** 특정 물건의 분석 실행이 실패하면(CLI 오류, 출력 파싱 실패 등)
- **THEN** 실패가 물건 식별자와 함께 로그에 남고, 나머지 대상 물건의 분석은 계속 진행된다

#### Scenario: 확장 필드를 활용한 분석
- **WHEN** 면적과 차수별 최저가가 있는 물건이 분석되면
- **THEN** 분석 결과가 면적당 가격과 차수별 저감 추이를 다룬다

#### Scenario: 확장 필드가 없는 물건 분석
- **WHEN** 확장 필드가 비어 있는 물건이 분석되면
- **THEN** 분석이 실패하지 않고, 없는 정보에 대해 추측하지 않은 결과가 생성된다

#### Scenario: 프롬프트 버전 상승
- **WHEN** 분석 입력이나 프롬프트가 변경되면
- **THEN** 프롬프트 버전이 올라가고, 저장되는 분석에 새 버전이 기록된다
