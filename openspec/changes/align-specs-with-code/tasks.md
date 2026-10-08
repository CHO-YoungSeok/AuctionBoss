## 1. 스펙 delta 검토

- [ ] 1.1 delta 7개의 MODIFIED 블록을 메인 스펙 원문과 diff해, 의도한 문장 외에 바뀐 곳과 빠진 시나리오가 없는지 확인한다. 요구사항 수와 시나리오 수를 표로 남긴다
- [ ] 1.2 고친 문장마다 근거 코드 위치와 그 동작을 지키는 테스트를 다시 열어 확인하고, 대조표(문장, 코드 파일:줄, 테스트)를 tasks 하단 메모에 남긴다
- [ ] 1.3 `openspec validate align-specs-with-code --strict`가 통과하는지 확인한다

## 2. 테스트가 없던 규칙에 회귀 테스트 추가 (동작 변경 없음)

- [ ] 2.1 `workers/lib/claude.ts`의 `runClaude`가 `ANTHROPIC_API_KEY`가 있으면 Messages API 경로를, 없으면 CLI 경로를 고르는지 테스트를 추가한다. 분기를 반대로 바꾸면 테스트가 실패하는지 변이로 확인한다
- [ ] 2.2 상세 화면이 이전 분석을 최근 10건까지만 본문으로 보여 주고 나머지는 건수로 보여 주는지 테스트를 추가한다(기존 상세 렌더 테스트 방식을 따른다). 한도를 바꾸면 실패하는지 변이로 확인한다

## 3. delta로 고칠 수 없는 부분

- [ ] 3.1 auction-analysis 메인 스펙의 Purpose에서 "서버 로컬의 Claude Code로" 문구를 "Claude(API 키가 있으면 Messages API, 없으면 로컬 CLI)로"에 맞게 직접 고친다
- [ ] 3.2 이번 범위 밖으로 남긴 불일치를 후속 목록으로 정리해 tasks 하단 메모에 남긴다: 사진 워커 결함(회차 기록, 백오프 공유, 재시도 간격, 어댑터 우회), 배포 설정(분석 워커 주소 변수, Next 이미지 curl), run-observability "정상 상태" 시나리오와 판정 코드의 차이, 표현 문제(빈 줄, 오타, change 시점 말투)

## 4. 마무리

- [ ] 4.1 게이트 5종(`npx tsc --noEmit`, `npm test`, `npm run build`, `npm run lint`, `cd backend && ./gradlew check`)이 통과하고 TS 테스트 수가 791에서 늘었는지 확인한다
- [ ] 4.2 `regression-verifier`로 회귀 검증을 받고 커밋, 푸시한다
- [ ] 4.3 아카이브(메인 스펙 동기화)하고, 동기화 전후 요구사항 수와 시나리오 수를 비교해 줄어든 것이 없는지 확인한다
