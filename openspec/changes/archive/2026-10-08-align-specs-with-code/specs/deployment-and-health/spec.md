## MODIFIED Requirements

### Requirement: 헬스체크 엔드포인트 (`GET /api/health`)
Next.js 웹 앱은 외부 로드밸런서, 쿠버네티스 프로브 및 모니터링 에이전트가 서비스 및 데이터베이스 상태를 점검할 수 있는 전용 헬스 엔드포인트(`GET /api/health`)를 제공해야(SHALL) 한다. 이 요구사항의 범위는 Next.js 웹 앱이며, 점검 대상 데이터베이스는 웹 앱이 쓰는 SQLite다. Spring 백엔드의 헬스체크는 이 요구사항이 아니라 `spring-backend` capability의 "헬스체크 호환" 요구사항이 정의한다.

#### Scenario: 정상 데이터베이스 연결 상태 응답
- **WHEN** 클라이언트가 `GET /api/health`를 호출하고 SQLite 데이터베이스 연결이 정상일 때
- **THEN** HTTP 200 상태 코드와 함께 `{"status":"ok","database":"connected","timestamp":...,"uptime":...}` 형식의 JSON을 반환한다.

#### Scenario: 데이터베이스 연결 실패 응답
- **WHEN** 클라이언트가 `GET /api/health`를 호출했으나 데이터베이스 쿼리 실행에 실패하거나 파일에 접근할 수 없을 때
- **THEN** HTTP 503 (Service Unavailable) 상태 코드와 함께 `{"status":"error","database":"disconnected","error":...}` 형식의 JSON을 반환한다.
