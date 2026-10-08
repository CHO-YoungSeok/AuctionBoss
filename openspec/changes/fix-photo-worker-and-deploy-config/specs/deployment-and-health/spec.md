## MODIFIED Requirements

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

## ADDED Requirements

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
