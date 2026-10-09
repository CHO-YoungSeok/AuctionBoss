# AuctionBoss

법원경매 물건을 수집하고, 웹에서 열람하며, AI 분석 결과를 함께 보여주는 서비스.

- **기술 스택**: 웹은 TypeScript + Next.js(App Router) + zod, 백엔드는 Spring Boot(Java 21) + MySQL(`backend/`). 수집·저장은 백엔드가 맡고 웹은 HTTP로만 읽는다
- **계획/스펙**: OpenSpec으로 관리 (`openspec/changes/`). 구현 전 해당 change의 proposal/design/specs/tasks를 먼저 확인할 것.
- **소스 격리**: 수집 소스 접근은 반드시 `AuctionSource` 어댑터 뒤로 격리한다. 소스 고유 형식이 어댑터 밖으로 새어 나가면 안 된다.
- **워커 통신**: 분석 워커(analyzer)는 DB를 직접 읽지 않는다. 서버와는 HTTP API로만 통신한다.

---

## 작업 방식: 오케스트레이터 + 서브에이전트

메인 세션은 **오케스트레이터(Orchestrator)**로 동작한다. 직접 모든 코드를 작성하거나 탐색하지 않고, 아래 위임 규칙에 따라 서브에이전트에 위임한 후 결과를 검증·통합하는 역할에 집중한다.

### 위임 규칙 (Antigravity 매핑)

| 작업 종류 | 위임 대상 | 모델 | 도구 권한 |
| :--- | :--- | :--- | :--- |
| **코드베이스 탐색/검색** (구조 파악, 심볼 찾기, 사용처 추적) | `research` (기본 제공) | `flash` | 읽기 전용 |
| **구현 계획 수립** (아키텍처 설계, 작업 분해 계획) | `planner` | `pro` | 읽기 전용 |
| **파일 수정/구현** (기능 구현, 리팩터링, 테스트 작성) | `code-writer` | `pro` / `flash` | 파일 수정 & 명령어 실행 가능 |
| **코드 리뷰** (설계 준수, 잠재적 버그, 안티패턴 검토) | `reviewer` | `pro` | 읽기 전용 |
| **회귀 검증** (커밋 전 빌드, 린트, 테스트 게이트 통과 확인) | `regression-verifier` | `pro` / `flash` | 파일 수정 & 명령어 실행 가능 |
| **오케스트레이터 직접 수행** | 작업 분해, 서브에이전트 정의(`define_subagent`) 및 호출(`invoke_subagent`), 결과 검증, 사용자와의 대화, OpenSpec 아티팩트 관리, git 커밋 | - | 전체 |

---

## 품질 게이트 (Gates)

다음 게이트 명령어는 작업 시작 및 종료 시점에 모두 통과해야 한다. 테스트 개수가 줄어들면 반드시 사유를 보고한다.
1. `npx tsc --noEmit`
2. `npm test`
3. `npm run build`
4. `npm run lint`

모든 변경 사항은 테스트로 회귀를 방지해야 하며, 코드 구현 후 커밋 전에 반드시 `regression-verifier` 서브에이전트에 회귀 검증을 위임하여 게이트를 검증한다.
