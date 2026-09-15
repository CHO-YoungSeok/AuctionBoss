# deployment-and-health Specification

## Purpose
AuctionBoss 애플리케이션의 서버 환경 안정 운영, 컨테이너화(Docker) 배포, 쿠버네티스(Kubernetes) 오케스트레이션 및 상태 프로브(Liveness/Readiness)를 위한 헬스체크 인터페이스와 운영 표준을 정의한다.

## Requirements

### Requirement: 헬스체크 엔드포인트 (`GET /api/health`)
시스템은 외부 로드밸런서, 쿠버네티스 프로브 및 모니터링 에이전트가 서비스 및 데이터베이스 상태를 점검할 수 있는 전용 헬스 엔드포인트를 제공해야(SHALL) 한다.

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

#### Scenario: Multi-container Pod를 통한 스토리지 공유
- **WHEN** Kubernetes에 `auctionboss` 워크로드가 배포될 때
- **THEN** Web 컨테이너와 Collector 워커 컨테이너가 동일 Pod 내에서 단일 ReadWriteOnce PVC(`/app/data`)를 공유하여 로컬 파일 잠금 및 WAL 모드를 안전하게 활용한다.

#### Scenario: K8s 프로브 연동
- **WHEN** Kubernetes kubelet이 Pod의 livenessProbe 및 readinessProbe를 수행할 때
- **THEN** Web 컨테이너의 `/api/health` 엔드포인트를 주기적으로 호출하여 Pod의 트래픽 수신 가능 여부를 판정한다.
