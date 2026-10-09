#!/usr/bin/env bash
# Spring 수집·사진 어댑터의 실제 사이트 최소 확인 (openspec port-collector-to-spring D13 절차 1~7, tasks 8.3 준비·8.4 실행).
#
# 기본은 dry-run이다: 루프백 가짜 소스 서버와 임시 SQLite만 쓰고 외부에는 요청하지 않는다. 실제 사이트로 나가려면
# 반드시 --i-confirm-live를 줘야 하고, 그 단계는 사람이 한 번만 실행한다(8.4). 이 스크립트는 CI에 넣지 않는다.
#
#   bash scripts/dev/live-check-collector.sh                       # dry-run(가짜 서버)
#   bash scripts/dev/live-check-collector.sh --dry-run-scenario recent-run   # 사전 확인이 실패해 중단되는 경로 (또는 backoff)
#   bash scripts/dev/live-check-collector.sh --i-confirm-live      # 실제 사이트. 요청은 수집 2 + 사진 2, 합계 4 이하
#
# 옵션
#   --i-confirm-live          실제 소스 주소로 요청한다(외부 요청 허용 켬). 없으면 dry-run.
#   --sqlite <경로>           TS SQLite(읽기 전용으로만 연다). 실제 실행 기본값 data/auctionboss.db.
#   --wait-seconds <N>        수집 뒤 사진 전 대기. 실제 실행은 60 미만으로 못 줄인다. dry-run 기본 3, 실제 기본 60.
#   --dry-run-scenario <ok|recent-run|backoff>   dry-run의 임시 SQLite 상태.
#
# 절차(D13)
#  1. 사전 확인: TS collector·photos가 멈춰 있는지(docker compose·프로세스), SQLite 백오프 만료, 직전 TS 회차가 15분 전인지.
#     하나라도 아니면 아무것도 만들지 않고 중단한다. 이 스크립트는 TS 워커를 멈추거나 켜지 않는다(사람이 한다).
#  2. 빈 확인용 DB: 임시 mysql:8.4 컨테이너(별도 포트, 볼륨 없음)의 비어 있는 auctionboss_live_check(Flyway만)와 임시 사진 디렉터리.
#     기존 개발 DB(auctionboss-mysql-dev)는 건드리지 않는다.
#  3. 수집 1회: --auctionboss.run-once=collector, 법원 1곳(설정의 첫 법원), max-pages=1 -> 세션 1 + 검색 1 = 요청 2.
#  4. 대기(실제 60초 이상) 뒤 5. 사진 1회: run-once=photos, 3에서 저장된 물건 하나만 -> 세션 1 + 상세 1 = 요청 2.
#  6. 확인: 회차 2건 성공, 요청 수 4 이하(회차 기록 기준), 사진 파일.
#  7. TS SQLite와 정규화 컬럼 비교(scripts/collector-golden/compare-live.ts, 읽기 전용, 건수만 출력).
#  8. 정리: 확인용 DB 컨테이너와 사진 디렉터리, 임시 파일 삭제.
# 출력은 요청 수·소요 시간·비교 불일치 건수뿐이다. 실데이터 값과 비밀 값은 출력하지 않는다.
#
# 끝난 뒤 사람이 할 일: TS 워커 재개 `docker compose start collector photos`(수집·사진 중 차단이 나오면 1시간 뒤에).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

LIVE=0
SQLITE=""
WAIT=""
SCENARIO="ok"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --i-confirm-live) LIVE=1; shift ;;
    --sqlite) SQLITE="${2:?--sqlite에 경로가 필요합니다}"; shift 2 ;;
    --wait-seconds) WAIT="${2:?--wait-seconds에 값이 필요합니다}"; shift 2 ;;
    --dry-run-scenario) SCENARIO="${2:?}"; shift 2 ;;
    *) echo "알 수 없는 옵션: $1" >&2; exit 2 ;;
  esac
done
[[ "$SCENARIO" =~ ^(ok|recent-run|backoff)$ ]] || { echo "--dry-run-scenario는 ok|recent-run|backoff" >&2; exit 2; }
if [[ "$LIVE" == 1 ]]; then
  [[ "$SCENARIO" == "ok" ]] || { echo "--dry-run-scenario는 실제 실행과 함께 쓸 수 없습니다" >&2; exit 2; }
  WAIT="${WAIT:-60}"
  [[ "$WAIT" =~ ^[0-9]+$ && "$WAIT" -ge 60 ]] || { echo "실제 실행의 대기는 60초 이상이어야 합니다" >&2; exit 2; }
  SQLITE="${SQLITE:-$ROOT/data/auctionboss.db}"
else
  WAIT="${WAIT:-3}"
  [[ "$WAIT" =~ ^[0-9]+$ ]] || { echo "--wait-seconds는 숫자" >&2; exit 2; }
fi

MYSQL_PORT="${LIVE_CHECK_MYSQL_PORT:-3397}"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/auctionboss-live-check.XXXXXX")"
CONTAINER="auctionboss-live-check-mysql-$$"
DB_NAME_="auctionboss_live_check"; DB_USER_="lck"; DB_PASSWORD_="lck-pass-$$"; ROOT_PASSWORD_="lck-root-$$"
PIDS=()
START_EPOCH=$(date +%s)

cleanup() {
  set +e
  for p in "${PIDS[@]:-}"; do [[ -n "$p" ]] && kill "$p" 2>/dev/null; done
  docker rm -f "$CONTAINER" >/dev/null 2>&1
  rm -rf "$WORK"
  echo "정리: 확인용 DB 컨테이너·사진 디렉터리·임시 파일 삭제"
}
trap cleanup EXIT

CL=(npx tsx scripts/collector-golden/compare-live.ts)
TSX=(npx tsx --tsconfig scripts/dev/tsconfig.snapshot.json)

if [[ "$LIVE" == 1 ]]; then
  echo "== 모드: 실제 사이트(--i-confirm-live). 요청은 수집 2 + 사진 2 =="
else
  echo "== 모드: dry-run(루프백 가짜 서버, 외부 요청 없음) =="
  "${TSX[@]}" scripts/dev/fake-source-server.ts --port-file "$WORK/fake.port" >"$WORK/fake.log" 2>&1 &
  PIDS+=("$!")
  for _ in $(seq 1 30); do [[ -s "$WORK/fake.port" ]] && break; sleep 1; done
  [[ -s "$WORK/fake.port" ]] || { echo "가짜 서버가 뜨지 않았습니다" >&2; exit 1; }
  FAKE_BASE="http://127.0.0.1:$(cat "$WORK/fake.port")"
  if [[ -z "$SQLITE" ]]; then
    SQLITE="$WORK/ts-dryrun.db"
    case "$SCENARIO" in
      ok) EXTRA=(--stale-run) ;;
      recent-run) EXTRA=(--recent-run) ;;
      backoff) EXTRA=(--stale-run --backoff) ;;
    esac
    "${TSX[@]}" scripts/dev/make-dryrun-sqlite.ts "$FAKE_BASE" "$SQLITE" "${EXTRA[@]}"
  fi
fi

# ----------------------------------------------------------------------------------------------
echo "== 1. 사전 확인 =="
PRE_FAIL=0
RUNNING=""
if command -v docker >/dev/null 2>&1; then
  RUNNING="$(docker compose ps --status running --services 2>/dev/null | grep -Ex 'collector|photos' | tr '\n' ' ' || true)"
fi
PROCS="$(pgrep -fl 'workers/(collector|photos)(\.ts)?' 2>/dev/null | grep -v pgrep || true)"
if [[ -n "$RUNNING" ]]; then echo "실패: TS 컨테이너가 실행 중: $RUNNING(docker compose stop collector photos 로 멈춘 뒤 다시)"; PRE_FAIL=1
else echo "통과: TS collector·photos 컨테이너 정지"; fi
if [[ -n "$PROCS" ]]; then echo "실패: TS 워커 프로세스가 실행 중(${PROCS%%$'\n'*} 외)"; PRE_FAIL=1
else echo "통과: TS 워커 프로세스 없음"; fi
[[ -f "$SQLITE" ]] || { echo "실패: SQLite를 찾을 수 없음($SQLITE)"; PRE_FAIL=1; }
if [[ -f "$SQLITE" ]]; then
  "${CL[@]}" preflight --sqlite "$SQLITE" || PRE_FAIL=1
fi
if [[ "$PRE_FAIL" != 0 ]]; then
  echo "== 사전 확인 실패: 아무것도 만들지 않고 중단합니다(요청 0) =="
  exit 1
fi

# ----------------------------------------------------------------------------------------------
echo "== 2. 빈 확인용 DB(임시 MySQL, Flyway만) =="
if lsof -iTCP:"$MYSQL_PORT" -sTCP:LISTEN -nP >/dev/null 2>&1; then echo "포트 $MYSQL_PORT가 이미 쓰이고 있습니다. LIVE_CHECK_MYSQL_PORT로 바꾸세요." >&2; exit 2; fi
docker run -d --name "$CONTAINER" -p "127.0.0.1:${MYSQL_PORT}:3306" \
  -e MYSQL_ROOT_PASSWORD="$ROOT_PASSWORD_" -e MYSQL_DATABASE="$DB_NAME_" -e MYSQL_USER="$DB_USER_" -e MYSQL_PASSWORD="$DB_PASSWORD_" \
  mysql:8.4 --character-set-server=utf8mb4 --collation-server=utf8mb4_0900_ai_ci >/dev/null
for _ in $(seq 1 60); do
  docker exec "$CONTAINER" mysqladmin ping -h 127.0.0.1 -u"$DB_USER_" -p"$DB_PASSWORD_" --silent >/dev/null 2>&1 && break; sleep 2
done
q() { docker exec -e MYSQL_PWD="$DB_PASSWORD_" "$CONTAINER" mysql --default-character-set=utf8mb4 -N -B -r -u"$DB_USER_" "$DB_NAME_" -e "$1" 2>/dev/null; }
(cd backend && ./gradlew bootJar -x test --console=plain -q)
JAR="$(ls -t backend/build/libs/*.jar | grep -v plain | head -1)"
mkdir -p "$WORK/photos"
# 설정: 실제 설정 파일에서 법원을 첫 곳만 남긴다(서울중앙). 원본 파일은 고치지 않는다.
node -e '
  const c = JSON.parse(require("fs").readFileSync("config/collector.json", "utf8"));
  c.scope = { ...c.scope, courts: [c.scope.courts[0]], maxCourtsPerRun: 1 };
  require("fs").writeFileSync(process.argv[1], JSON.stringify(c, null, 2));
' "$WORK/collector.json"
echo "빈 DB 물건 수: $(q 'SELECT COUNT(*) FROM items' || echo 'Flyway 전')"

run_once() { # 모드, 추가 인자...  -> 종료 코드
  local mode="$1"; shift
  local src=()
  if [[ "$LIVE" == 1 ]]; then src=(--auctionboss.source.external-requests-allowed=true)
  else src=(--auctionboss.source.base-url="$FAKE_BASE" --auctionboss.source.external-requests-allowed=false); fi
  # 접속 정보는 임시 컨테이너 것만 쓴다(환경 변수가 저장소 .env보다 우선).
  DB_HOST=127.0.0.1 DB_PORT="$MYSQL_PORT" DB_NAME="$DB_NAME_" DB_USER="$DB_USER_" DB_PASSWORD="$DB_PASSWORD_" \
  SPRING_PROFILES_ACTIVE=local \
    java -jar "$JAR" --auctionboss.run-once="$mode" --auctionboss.config-path="$WORK/collector.json" \
      --auctionboss.photos.dir="$WORK/photos" "${src[@]}" "$@" >"$WORK/run-$mode.log" 2>&1
}

# ----------------------------------------------------------------------------------------------
stats_requests() { curl -fsS "$FAKE_BASE/__stats" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).requests))'; }
[[ "$LIVE" == 1 ]] || FAKE_REQ0=$(stats_requests)   # 임시 SQLite를 만들 때 TS 어댑터가 보낸 요청은 뺀다
echo "== 3. 수집 1회(법원 1곳, max-pages=1) =="
T0=$SECONDS
RC_C=0; run_once collector --auctionboss.source.max-pages=1 --auctionboss.collector.max-courts-per-run=1 || RC_C=$?
echo "종료 코드 $RC_C, 소요 $((SECONDS - T0))초"

RC_P=skipped; PHOTO_ID=""
if [[ "$RC_C" == 0 ]]; then
  echo "== 4. 대기 ${WAIT}초 =="
  sleep "$WAIT"
  echo "== 5. 사진 1회(저장된 물건 하나만) =="
  PHOTO_ID="$(q "SELECT id FROM items WHERE internal_case_no IS NOT NULL AND court_code IS NOT NULL ORDER BY id LIMIT 1")"
  if [[ -z "$PHOTO_ID" ]]; then echo "사진 대상 물건이 없습니다(내부 사건번호 없음)"; else
    T1=$SECONDS
    RC_P=0; run_once photos --auctionboss.photos.only-item-id="$PHOTO_ID" --auctionboss.photos.max-items-per-run=1 || RC_P=$?
    echo "종료 코드 $RC_P, 소요 $((SECONDS - T1))초"
  fi
else
  echo "수집이 성공하지 않아 사진은 건너뜁니다(차단이면 TS 워커 재개는 1시간 뒤에)."
fi

# ----------------------------------------------------------------------------------------------
echo "== 6. 확인 =="
FAILS=0
check() { if [[ "$2" == 0 ]]; then echo "  통과: $1"; else echo "  실패: $1"; FAILS=$((FAILS + 1)); fi; }
C_OK=$(q "SELECT COUNT(*) FROM worker_runs WHERE worker='collector' AND outcome='success'")
P_OK=$(q "SELECT COUNT(*) FROM worker_runs WHERE worker='photos' AND outcome='success'")
BAD=$(q "SELECT COUNT(*) FROM worker_runs WHERE outcome IN ('failed','blocked')")
PAGES=$(q "SELECT COALESCE(SUM(JSON_EXTRACT(detail,'\$.pagesRequested')),0) FROM worker_runs WHERE worker='collector' AND outcome='success'")
PHOTO_REQ=$(q "SELECT COALESCE(SUM(JSON_EXTRACT(detail,'\$.requestsMade')),0) FROM worker_runs WHERE worker='photos' AND outcome='success'")
REQ_C=$([[ "$C_OK" -ge 1 ]] && echo $((PAGES + 1)) || echo 0)   # 검색 페이지 + 세션 1
REQ_TOTAL=$((REQ_C + PHOTO_REQ))
ITEMS=$(q "SELECT COUNT(*) FROM items")
FILES=$(find "$WORK/photos" -type f | wc -l | tr -d ' ')
PHOTO_ROWS=$(q "SELECT COUNT(*) FROM item_photos")
echo "  회차: 수집 성공 $C_OK, 사진 성공 $P_OK, 실패·차단 $BAD"
echo "  요청: 수집 $REQ_C(세션 1 + 검색 ${PAGES}), 사진 $PHOTO_REQ, 합계 $REQ_TOTAL"
echo "  확인용 DB 물건 ${ITEMS}건, 사진 행 ${PHOTO_ROWS}, 사진 파일 ${FILES}개"
check "수집 회차 성공 1건" "$([[ "$C_OK" == 1 ]] && echo 0 || echo 1)"
check "사진 회차 성공 1건" "$([[ "$P_OK" == 1 ]] && echo 0 || echo 1)"
check "실패·차단 회차 0건" "$([[ "$BAD" == 0 ]] && echo 0 || echo 1)"
check "요청 수 4 이하(수집 2 + 사진 2 기대)" "$([[ "$REQ_TOTAL" -le 4 && "$REQ_TOTAL" -ge 1 ]] && echo 0 || echo 1)"
check "저장된 물건 1건 이상" "$([[ "$ITEMS" -ge 1 ]] && echo 0 || echo 1)"
check "사진 파일이 행 수만큼 저장됨" "$([[ "$PHOTO_ROWS" -ge 1 && "$FILES" == "$PHOTO_ROWS" ]] && echo 0 || echo 1)"
if [[ "$LIVE" != 1 ]]; then
  FAKE_REQ=$(( $(stats_requests) - FAKE_REQ0 ))
  echo "  (dry-run) 가짜 서버가 받은 요청 $FAKE_REQ건"
  check "가짜 서버가 받은 요청 수가 회차 기록의 요청 수와 같다" "$([[ "$FAKE_REQ" == "$REQ_TOTAL" ]] && echo 0 || echo 1)"
fi
if [[ "$BAD" != 0 ]]; then
  echo "  실패·차단 회차(종류와 메시지 첫 줄만):"
  q "SELECT worker, outcome, COALESCE(error_kind,''), LEFT(SUBSTRING_INDEX(COALESCE(error_message,''),'\n',1),120) FROM worker_runs WHERE outcome IN ('failed','blocked')" | sed 's/^/    /'
fi

# ----------------------------------------------------------------------------------------------
echo "== 7. TS SQLite와 비교(읽기 전용, 건수만) =="
if [[ "$ITEMS" -ge 1 ]]; then
  "${CL[@]}" print-sql | { read -r SQL; q "$SQL" >"$WORK/spring-items.ndjson"; }
  CMP_RC=0
  "${CL[@]}" compare --spring-ndjson "$WORK/spring-items.ndjson" --sqlite "$SQLITE" || CMP_RC=$?
  [[ "$CMP_RC" == 0 ]] || FAILS=$((FAILS + 1))
else
  echo "  비교할 물건이 없습니다"
fi

echo
echo "== 요약: 요청 합계 $REQ_TOTAL, 소요 $(( $(date +%s) - START_EPOCH ))초(대기 ${WAIT}초 포함), 점검 실패 ${FAILS}건 =="
if [[ "$LIVE" == 1 ]]; then echo "TS 워커 재개: docker compose start collector photos (이번에 차단이 나왔다면 1시간 뒤에)"; fi
[[ "$FAILS" == 0 ]] || exit 1
