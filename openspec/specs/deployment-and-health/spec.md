# deployment-and-health Specification

## Purpose
AuctionBoss 애플리케이션의 서버 환경 안정 운영, 컨테이너화(Docker) 배포, 쿠버네티스(Kubernetes) 오케스트레이션 및 상태 프로브(Liveness/Readiness)를 위한 헬스체크 인터페이스와 운영 표준을 정의한다.

## Requirements

### Requirement: 헬스체크 엔드포인트 (`GET /api/health`)
Next.js 웹 앱은 외부 로드밸런서, 쿠버네티스 프로브 및 모니터링 에이전트가 서비스 및 데이터베이스 상태를 점검할 수 있는 전용 헬스 엔드포인트(`GET /api/health`)를 제공해야(SHALL) 한다. 이 요구사항의 범위는 Next.js 웹 앱이며, 점검 대상 데이터베이스는 웹 앱이 쓰는 SQLite다. Spring 백엔드의 헬스체크는 이 요구사항이 아니라 `spring-backend` capability의 "헬스체크 호환" 요구사항이 정의한다.

#### Scenario: 정상 데이터베이스 연결 상태 응답
- **WHEN** 클라이언트가 `GET /api/health`를 호출하고 SQLite 데이터베이스 연결이 정상일 때
- **THEN** HTTP 200 상태 코드와 함께 `{"status":"ok","database":"connected","timestamp":...,"uptime":...}` 형식의 JSON을 반환한다.

#### Scenario: 데이터베이스 연결 실패 응답
- **WHEN** 클라이언트가 `GET /api/health`를 호출했으나 데이터베이스 쿼리 실행에 실패하거나 파일에 접근할 수 없을 때
- **THEN** HTTP 503 (Service Unavailable) 상태 코드와 함께 `{"status":"error","database":"disconnected","error":...}` 형식의 JSON을 반환한다.

### Requirement: 컨테이너 런타임 및 볼륨 영속성
시스템은 SQLite 데이터베이스(`data/auctionboss.db`) 및 다운로드된 파일 자산의 손실을 방지하기 위해 컨테이너 파일시스템 외부의 영속 볼륨 마운트를 지원해야(SHALL) 한다.

#### Scenario: 컨테이너 환경에서 볼륨 마운트를 통한 데이터 영속화
- **WHEN** 컨테이너가 `/app/data` 디렉터리를 외부 볼륨(Docker Volume 또는 K8s PVC)으로 마운트하여 기동될 때
- **THEN** 애플리케이션은 기존 DB 파일 및 스키마를 유지하며 재시작 후에도 데이터를 온전히 보존한다.

### Requirement: 쿠버네티스 워크로드 구성
시스템은 단일 노드 또는 클러스터 환경에서 SQLite 동시 쓰기 잠금 충돌을 회피하고 수집 워커와 웹 서버가 조화롭게 동작하도록 쿠버네티스 리소스를 정의해야(SHALL) 한다.

SQLite 파일에 직접 쓰는 컨테이너(웹, 수집 워커, 사진 워커)는 모두 같은 Pod 안에서 하나의 데이터 볼륨을 공유해야 한다(SHALL). 분석 워커는 데이터베이스를 직접 열지 않으므로 별도 워크로드로 둘 수 있으며(SHALL), 서버 주소는 분석 워커 코드가 실제로 읽는 환경 변수 이름으로 전달되어야 한다(MUST) — 이름이 다르면 워커가 기본 주소로 요청해 서버를 찾지 못한다.

#### Scenario: Multi-container Pod를 통한 스토리지 공유
- **WHEN** Kubernetes에 `auctionboss` 워크로드가 배포될 때
- **THEN** Web 컨테이너, Collector 워커 컨테이너, 사진 워커 컨테이너가 동일 Pod 내에서 단일 ReadWriteOnce PVC(`/app/data`)를 공유하여 로컬 파일 잠금 및 WAL 모드를 안전하게 활용한다.

#### Scenario: K8s 프로브 연동
- **WHEN** Kubernetes kubelet이 Pod의 livenessProbe 및 readinessProbe를 수행할 때
- **THEN** Web 컨테이너의 `/api/health` 엔드포인트를 주기적으로 호출하여 Pod의 트래픽 수신 가능 여부를 판정한다.

#### Scenario: 분석 워커의 서버 주소
- **WHEN** 분석 워커 워크로드가 배포될 때
- **THEN** 분석 워커가 읽는 서버 주소 환경 변수에 웹 서비스 주소가 들어 있어, 분석 워커가 클러스터 안의 웹 서버로 요청한다.

### Requirement: Docker Compose 구성
시스템은 `docker compose`로 웹 서버, 수집 워커, 사진 워커, 분석 워커를 함께 띄울 수 있는 구성을 제공해야 한다(SHALL). SQLite 파일에 직접 쓰는 서비스(웹, 수집 워커, 사진 워커)는 같은 데이터 볼륨을 공유해야 한다(SHALL).

각 서비스에 전달하는 환경 변수 이름은 그 서비스의 코드가 실제로 읽는 이름과 같아야 한다(MUST). 분석 워커에는 웹 서비스 주소가 서버 주소 환경 변수로 전달되어야 하며(SHALL), Claude API 키는 호스트 환경에 있을 때만 전달되고 없을 때도 구성 자체는 동작해야 한다(SHALL). 비밀 값은 저장소에 두어서는 안 된다(MUST NOT).

웹 서비스의 헬스체크는 웹 이미지에 실제로 들어 있는 실행 파일만으로 동작해야 하며(MUST), `GET /api/health`가 200일 때만 정상으로 판정해야 한다(SHALL) — 이미지에 없는 도구를 부르면 서비스가 정상이어도 헬스체크가 항상 실패한다.

#### Scenario: 분석 워커가 웹 서버를 찾음
- **WHEN** compose로 웹 서버와 분석 워커를 띄우면
- **THEN** 분석 워커가 웹 서비스 주소로 요청하고, 기본 주소(로컬호스트)로 요청하지 않는다

#### Scenario: API 키가 없는 호스트
- **WHEN** 호스트 환경에 Claude API 키가 없는 상태로 compose를 실행하면
- **THEN** 구성이 오류 없이 해석되고 다른 서비스는 정상 기동한다

#### Scenario: 웹 헬스체크
- **WHEN** 웹 서버가 정상 기동하고 데이터베이스가 연결된 상태에서 헬스체크가 실행되면
- **THEN** 헬스체크가 성공하고 서비스가 정상(healthy)으로 표시된다

#### Scenario: 웹 헬스체크 실패
- **WHEN** `GET /api/health`가 503을 돌려주면
- **THEN** 헬스체크가 실패로 판정된다

#### Scenario: 사진 워커 서비스
- **WHEN** compose로 전체 서비스를 띄우면
- **THEN** 사진 워커가 웹·수집 워커와 같은 데이터 볼륨으로 상주 실행된다
