## MODIFIED Requirements

### Requirement: 헬스체크 엔드포인트 (`GET /api/health`)
Next.js 웹 앱은 외부 로드밸런서, 쿠버네티스 프로브 및 모니터링 에이전트가 서비스 상태를 점검할 수 있는 전용 헬스 엔드포인트(`GET /api/health`)를 제공해야(SHALL) 한다. 웹 앱은 데이터베이스를 직접 열지 않으므로, 데이터베이스 상태는 데이터 포트로 백엔드 헬스체크를 불러 판정해야 한다(SHALL). 웹 앱은 헬스체크 때문에 데이터베이스 파일을 만들거나 열면 안 된다(MUST NOT). Spring 백엔드 자신의 헬스체크는 `spring-backend` capability의 "헬스체크 호환" 요구사항이 정의한다.

#### Scenario: 정상 데이터베이스 연결 상태 응답
- **WHEN** 클라이언트가 `GET /api/health`를 호출하고 백엔드 헬스체크가 200일 때
- **THEN** HTTP 200 상태 코드와 함께 `{"status":"ok","database":"connected","timestamp":...,"uptime":...}` 형식의 JSON을 반환한다.

#### Scenario: 데이터베이스 연결 실패 응답
- **WHEN** 클라이언트가 `GET /api/health`를 호출했으나 백엔드에 연결할 수 없거나, 정해진 시간 안에 응답이 없거나, 백엔드 헬스체크가 503일 때
- **THEN** HTTP 503 (Service Unavailable) 상태 코드와 함께 `{"status":"error","database":"disconnected","error":...}` 형식의 JSON을 반환하고, 오류에 비밀 값을 담지 않는다.

### Requirement: 컨테이너 런타임 및 볼륨 영속성
시스템은 MySQL 데이터와 사진 파일의 손실을 막기 위해 컨테이너 파일시스템 밖의 영속 볼륨을 써야 한다(SHALL). MySQL 데이터 디렉터리와 백엔드 사진 디렉터리는 각각 볼륨(Docker Volume 또는 K8s PVC)에 두어야 한다(SHALL). 웹 앱과 분석 워커는 데이터 볼륨을 마운트하지 않아야 한다(SHALL).

#### Scenario: 컨테이너 환경에서 볼륨 마운트를 통한 데이터 영속화
- **WHEN** MySQL과 백엔드 컨테이너를 지우고 같은 볼륨으로 다시 만든다
- **THEN** 물건·이력·분석과 사진 파일이 그대로 조회된다

#### Scenario: 웹 앱 볼륨 없음
- **WHEN** 운영 구성의 웹 앱 컨테이너 설정을 확인한다
- **THEN** 데이터 볼륨 마운트가 없고 데이터베이스 파일 경로 환경 변수가 없다

## ADDED Requirements

### Requirement: 쿠버네티스 백엔드 중심 워크로드 구성
시스템은 단일 노드 환경을 기준으로 웹, 백엔드, MySQL, 분석 워커를 쿠버네티스 리소스로 정의해야 한다(SHALL).

백엔드는 인스턴스 하나로 두고 업데이트 때 이전 인스턴스를 먼저 내려야 하며(SHALL), 수집·사진 주기 실행과 외부 요청 허용을 켜야 한다(SHALL). MySQL은 영속 볼륨을 가진 워크로드로 두어야 하며(SHALL), 접속 정보는 Secret에서 주입해야 하고 매니페스트에 실제 값을 두면 안 된다(MUST NOT). 웹 Pod에는 수집·사진 워커 컨테이너가 없어야 한다(SHALL). 웹과 분석 워커의 서버 주소는 각 코드가 실제로 읽는 환경 변수 이름으로 백엔드 서비스 주소를 받아야 한다(MUST) — 이름이 다르면 기본 주소로 요청해 서버를 찾지 못한다. 백엔드 서비스는 클러스터 밖에 노출하지 않아야 한다(SHALL).

#### Scenario: 워크로드 구성
- **WHEN** Kubernetes에 `auctionboss` 매니페스트를 적용한다
- **THEN** 웹 Deployment에는 웹 컨테이너 하나만 있고, 백엔드 Deployment는 인스턴스 하나에 수집·사진 주기 실행이 켜져 있으며, MySQL은 영속 볼륨을 가진다

#### Scenario: K8s 프로브 연동
- **WHEN** Kubernetes kubelet이 웹 Pod의 livenessProbe 및 readinessProbe를 수행할 때
- **THEN** readinessProbe는 `/api/health`로 트래픽 수신 가능 여부를 판정하고, livenessProbe는 백엔드 중단만으로 웹 컨테이너를 재시작하지 않는다

#### Scenario: 분석 워커와 웹의 서버 주소
- **WHEN** 분석 워커와 웹 워크로드가 배포될 때
- **THEN** 분석 워커의 서버 주소 환경 변수와 웹의 백엔드 주소 환경 변수에 백엔드 서비스 주소가 들어 있다

### Requirement: Docker Compose 운영 구성
시스템은 `docker compose`로 MySQL, 백엔드, 웹 서버, 분석 워커를 함께 띄울 수 있는 운영 구성을 제공해야 한다(SHALL). 운영 구성에는 기존 수집 워커와 사진 워커 서비스가 없어야 하며(SHALL), 물건·사진 수집은 백엔드가 맡는다. 웹 서버는 데이터 원천을 백엔드로 두고 백엔드가 정상이 된 뒤에 시작해야 한다(SHALL).

각 서비스에 전달하는 환경 변수 이름은 그 서비스의 코드가 실제로 읽는 이름과 같아야 한다(MUST). 분석 워커에는 백엔드 서비스 주소가 서버 주소 환경 변수로 전달되어야 하며(SHALL), Claude API 키는 호스트 환경에 있을 때만 전달되고 없을 때도 구성 자체는 동작해야 한다(SHALL). 데이터베이스 접속 정보는 운영 구성 전체에 필수이므로, 값이 없으면 구성 해석 단계에서 어떤 값이 없는지 알리며 실패해야 한다(SHALL). 비밀 값은 저장소에 두어서는 안 된다(MUST NOT). 백엔드와 MySQL 포트는 호스트의 루프백에만 열어야 한다(SHALL).

웹 서비스의 헬스체크는 웹 이미지에 실제로 들어 있는 실행 파일만으로 동작해야 하며(MUST), `GET /api/health`가 200일 때만 정상으로 판정해야 한다(SHALL) — 이미지에 없는 도구를 부르면 서비스가 정상이어도 헬스체크가 항상 실패한다.

#### Scenario: 분석 워커가 백엔드를 찾음
- **WHEN** compose로 운영 구성을 띄우면
- **THEN** 분석 워커가 백엔드 서비스 주소로 요청하고, 기본 주소(로컬호스트)나 웹 서비스로 요청하지 않는다

#### Scenario: API 키가 없는 호스트
- **WHEN** 호스트 환경에 Claude API 키가 없는 상태로 compose를 실행하면
- **THEN** 구성이 오류 없이 해석되고 다른 서비스는 정상 기동한다

#### Scenario: 데이터베이스 접속 정보가 없는 호스트
- **WHEN** 데이터베이스 비밀번호가 없는 상태로 운영 구성을 해석하면
- **THEN** 어떤 변수가 없는지 알리며 실패하고 어떤 서비스도 시작하지 않는다

#### Scenario: 웹 헬스체크
- **WHEN** 웹 서버와 백엔드가 정상 기동한 상태에서 헬스체크가 실행되면
- **THEN** 헬스체크가 성공하고 서비스가 정상(healthy)으로 표시된다

#### Scenario: 웹 헬스체크 실패
- **WHEN** `GET /api/health`가 503을 돌려주면
- **THEN** 헬스체크가 실패로 판정된다

#### Scenario: 수집 워커 서비스 없음
- **WHEN** compose 운영 구성의 서비스 목록을 확인하면
- **THEN** 기존 수집 워커와 사진 워커 서비스가 없고, 백엔드가 수집·사진 주기 실행과 외부 요청 허용을 켠 채 사진 볼륨을 마운트한다

## REMOVED Requirements

### Requirement: 쿠버네티스 워크로드 구성
**Reason**: SQLite 파일을 같은 Pod에서 공유하려던 구성(웹·수집·사진 워커 다중 컨테이너 Pod, 분석 워커 → 웹)이다. SQLite가 은퇴하고 수집·사진은 백엔드가 맡으며 분석 워커는 백엔드와 통신한다.
**Migration**: "쿠버네티스 백엔드 중심 워크로드 구성"을 따른다.

### Requirement: Docker Compose 구성
**Reason**: 웹·수집·사진 워커가 SQLite 볼륨을 공유하고 분석 워커가 웹 서버와 통신하던 구성이다. 운영 구성에서 TS 수집·사진 워커가 빠지고 분석 워커가 백엔드로 바뀐다.
**Migration**: "Docker Compose 운영 구성"을 따른다.
