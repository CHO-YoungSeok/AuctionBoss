#!/usr/bin/env bash
# Spring 수집·사진 워커 개발 환경 검증: 루프백 가짜 소스 서버 전체 경로 (openspec port-collector-to-spring D13, tasks 8.1).
#
#   bash scripts/dev/verify-collector-on-spring.sh
#
# 외부 사이트에는 요청하지 않는다. 소스 주소는 가짜 서버(127.0.0.1)뿐이고 외부 요청 허용은 꺼 둔다(--...external-requests-allowed=false).
# 기존 개발 DB(auctionboss-mysql-dev, 볼륨)와 TS collector/photos 컨테이너는 건드리지 않는다. CI에는 넣지 않는다(Docker·JDK 필요).
#
# 하는 일
#  1. 임시 mysql:8.4 컨테이너(별도 포트, 볼륨 없음)와 루프백 가짜 소스 서버(scripts/dev/fake-source-server.ts)를 띄운다.
#  2. [단계 1] Spring 한 개: 스케줄러 켬(수집 주기 3초, 사진 주기 12초). 수집 3회 이상 + 사진 1회를 기다린 뒤 멈추고
#     worker_runs, GET /api/items, 사진 파일 API(가짜 서버가 보낸 바이트와 SHA-256 비교)를 확인한다.
#  3. [단계 2] Spring 두 개(같은 MySQL): 가짜 서버가 검색 응답을 5초 늦춰 회차가 주기(2초)보다 길게 한다. overlap 건너뜀이 생기고
#     성공 회차의 실행 구간이 서로 겹치지 않으며 가짜 서버가 본 동시 요청 최대값이 1인지 확인한다.
#  4. 가짜 서버로 가는 연결 말고는 없었는지 확인한다: Spring 프로세스의 TCP 연결 상대(lsof 표본), Spring 로그의 URL 호스트,
#     가짜 서버가 본 Host 헤더·접속 주소, "외부 요청이 허용되지 않았습니다" 로그 0건.
#     (어댑터는 요청 대상 호스트를 로그로 남기지 않아 위 네 가지로 갈음한다.)
#  5. 모두 정리한다. 비밀 값은 출력하지 않는다(임시 컨테이너 전용 값만 쓴다).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

MYSQL_PORT="${VERIFY_MYSQL_PORT:-3398}"
PORT_A="${VERIFY_PORT_A:-8091}"
PORT_B="${VERIFY_PORT_B:-8092}"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/auctionboss-verify-collector.XXXXXX")"
CONTAINER="auctionboss-verify-collector-mysql-$$"
DB_NAME_="auctionboss_verify"; DB_USER_="vfy"; DB_PASSWORD_="vfy-pass-$$"; ROOT_PASSWORD_="vfy-root-$$"
PIDS=()
FAILS=0

cleanup() {
  set +e
  for p in "${PIDS[@]:-}"; do [[ -n "$p" ]] && kill "$p" 2>/dev/null; done
  sleep 1
  for p in "${PIDS[@]:-}"; do [[ -n "$p" ]] && kill -9 "$p" 2>/dev/null; done
  docker rm -f "$CONTAINER" >/dev/null 2>&1
  if [[ -n "${KEEP_WORK:-}" ]]; then echo "임시 디렉터리 보존: $WORK"; else rm -rf "$WORK"; fi
}
trap cleanup EXIT

check() { # 설명, 조건(0이면 통과)
  if [[ "$2" == "0" ]]; then echo "  통과: $1"; else echo "  실패: $1"; FAILS=$((FAILS + 1)); fi
}
ok_if() { if eval "$2"; then check "$1" 0; else check "$1" 1; fi; }

for port in "$MYSQL_PORT" "$PORT_A" "$PORT_B"; do
  if lsof -iTCP:"$port" -sTCP:LISTEN -nP >/dev/null 2>&1; then echo "포트 $port가 이미 쓰이고 있습니다. VERIFY_* 환경 변수로 다른 포트를 지정하세요." >&2; exit 2; fi
done

q() { docker exec -e MYSQL_PWD="$DB_PASSWORD_" "$CONTAINER" mysql --default-character-set=utf8mb4 -N -B -r -u"$DB_USER_" "$DB_NAME_" -e "$1" 2>/dev/null; }
wait_http() { for _ in $(seq 1 "$2"); do curl -fsS -o /dev/null "$1" 2>/dev/null && return 0; sleep 1; done; echo "응답 없음: $1" >&2; return 1; }
json() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log(eval(process.argv[1]))})' "$1"; }

echo "== 1. 임시 MySQL + 가짜 소스 서버 + jar =="
docker run -d --name "$CONTAINER" -p "127.0.0.1:${MYSQL_PORT}:3306" \
  -e MYSQL_ROOT_PASSWORD="$ROOT_PASSWORD_" -e MYSQL_DATABASE="$DB_NAME_" -e MYSQL_USER="$DB_USER_" -e MYSQL_PASSWORD="$DB_PASSWORD_" \
  mysql:8.4 --character-set-server=utf8mb4 --collation-server=utf8mb4_0900_ai_ci >/dev/null
for _ in $(seq 1 60); do
  docker exec "$CONTAINER" mysqladmin ping -h 127.0.0.1 -u"$DB_USER_" -p"$DB_PASSWORD_" --silent >/dev/null 2>&1 && break; sleep 2
done
(cd backend && ./gradlew bootJar -x test --console=plain -q)
JAR="$(ls -t backend/build/libs/*.jar | grep -v plain | head -1)"

TSX=(npx tsx --tsconfig scripts/dev/tsconfig.snapshot.json)
start_fake() { # 이름, 추가 인자... -> FAKE_PORT 설정
  local name="$1"; shift
  "${TSX[@]}" scripts/dev/fake-source-server.ts --port-file "$WORK/$name.port" --log "$WORK/$name.requests.jsonl" "$@" >"$WORK/$name.log" 2>&1 &
  PIDS+=("$!")
  for _ in $(seq 1 30); do [[ -s "$WORK/$name.port" ]] && break; sleep 1; done
  [[ -s "$WORK/$name.port" ]] || { echo "가짜 서버($name)가 뜨지 않았습니다" >&2; cat "$WORK/$name.log" >&2; exit 1; }
  FAKE_PORT="$(cat "$WORK/$name.port")"
}

write_config() { # 파일, 수집 주기(ms)
  node -e '
    const c = JSON.parse(require("fs").readFileSync("config/collector.json", "utf8"));
    c.scope = { courts: [c.scope.courts[0]], maxCourtsPerRun: 1, maxRequestsPerRun: 13 };
    c.intervalMs = Number(process.argv[2]);
    c.photos = { intervalMs: 12000, maxItemsPerRun: 3, requestDelayMs: 300, retryAfterHours: 24 };
    require("fs").writeFileSync(process.argv[1], JSON.stringify(c, null, 2));
  ' "$1" "$2"
}

# Spring 시작: 이름, 서버 포트, 가짜 서버 포트, 설정 파일, 사진 디렉터리, 사진 켬(true/false)
SPRING_PID=""
start_spring() {
  local name="$1" port="$2" fake="$3" cfg="$4" photos_dir="$5" photos_on="$6"
  # 접속 정보는 임시 컨테이너 것만 쓴다(환경 변수가 저장소 .env보다 우선).
  DB_HOST=127.0.0.1 DB_PORT="$MYSQL_PORT" DB_NAME="$DB_NAME_" DB_USER="$DB_USER_" DB_PASSWORD="$DB_PASSWORD_" \
  SPRING_PROFILES_ACTIVE=local \
    java -jar "$JAR" \
      --server.port="$port" \
      --auctionboss.config-path="$cfg" \
      --auctionboss.source.base-url="http://127.0.0.1:${fake}" \
      --auctionboss.source.external-requests-allowed=false \
      --auctionboss.collector.enabled=true \
      --auctionboss.photos.enabled="$photos_on" \
      --auctionboss.photos.run-immediately=false \
      --auctionboss.photos.dir="$photos_dir" \
      --auctionboss.workers.shutdown-wait-ms=3000 \
      >"$WORK/spring-$name.log" 2>&1 &
  SPRING_PID=$!; PIDS+=("$SPRING_PID")
  wait_http "http://127.0.0.1:${port}/api/items?pageSize=1" 120
}
stop_pid() { kill "$1" 2>/dev/null || true; for _ in $(seq 1 20); do kill -0 "$1" 2>/dev/null || return 0; sleep 1; done; kill -9 "$1" 2>/dev/null || true; }
# lsof 표본(연결 상대만)을 파일에 이어 쓴다.
sample_peers() { lsof -nP -a -p "$1" -iTCP 2>/dev/null | grep -o -- '->[^ ]*' >>"$WORK/peers.txt" || true; }

# --------------------------------------------------------------------------------------------------
echo "== 2. 단계 1: Spring 하나, 수집 3회 + 사진 1회 =="
start_fake fake1
FAKE1="$FAKE_PORT"
write_config "$WORK/collector-1.json" 3000
mkdir -p "$WORK/photos"
start_spring a1 "$PORT_A" "$FAKE1" "$WORK/collector-1.json" "$WORK/photos" true
A1_PID="$SPRING_PID"
C=0; P=0
for _ in $(seq 1 90); do
  sample_peers "$A1_PID"
  C=$(q "SELECT COUNT(*) FROM worker_runs WHERE worker='collector' AND outcome='success'")
  P=$(q "SELECT COUNT(*) FROM worker_runs WHERE worker='photos' AND outcome='success'")
  [[ "$C" -ge 3 && "$P" -ge 1 ]] && break
  sleep 1
done
sample_peers "$A1_PID"
echo "  수집 success=$C, 사진 success=$P"
check "수집 성공 회차 3회 이상" "$([[ "$C" -ge 3 ]] && echo 0 || echo 1)"
check "사진 성공 회차 1회 이상" "$([[ "$P" -ge 1 ]] && echo 0 || echo 1)"
check "실패·차단 회차 0건" "$([[ "$(q "SELECT COUNT(*) FROM worker_runs WHERE outcome IN ('failed','blocked')")" == "0" ]] && echo 0 || echo 1)"
echo "  회차(최근 5건: worker, outcome, 요약):"
q "SELECT worker, outcome, LEFT(COALESCE(detail,''),150) FROM worker_runs WHERE outcome<>'running' ORDER BY id DESC LIMIT 5" | sed 's/^/    /'

# GET /api/items가 저장된 물건을 돌려주는가
DB_ITEMS=$(q "SELECT COUNT(*) FROM items")
ITEMS_API="$(curl -fsS "http://127.0.0.1:${PORT_A}/api/items?pageSize=50")"
API_COUNT=$(echo "$ITEMS_API" | json '(j.items ?? j.content ?? j.data ?? []).length')
echo "  items(DB)=$DB_ITEMS, GET /api/items 항목 수=$API_COUNT"
check "GET /api/items가 저장된 물건과 같은 수" "$([[ "$DB_ITEMS" -ge 1 && "$API_COUNT" == "$DB_ITEMS" ]] && echo 0 || echo 1)"

# 사진 파일 API: 가짜 서버가 보낸 바이트와 SHA-256이 같아야 한다.
PICS="$(curl -fsS "http://127.0.0.1:${FAKE1}/__pics")"
PHOTO_ROWS=$(q "SELECT COUNT(*) FROM item_photos")
PHOTO_CHECKED=0; PHOTO_BAD=0
while IFS=$'\t' read -r item_id seq; do
  [[ -z "$item_id" ]] && continue
  want=$(echo "$PICS" | json "j.find(p => p.seq === ${seq})?.sha256 ?? ''")
  got=$(curl -fsS "http://127.0.0.1:${PORT_A}/api/photos/${item_id}/${seq}" | shasum -a 256 | cut -d' ' -f1)
  PHOTO_CHECKED=$((PHOTO_CHECKED + 1))
  [[ -n "$want" && "$want" == "$got" ]] || PHOTO_BAD=$((PHOTO_BAD + 1))
done < <(q "SELECT item_id, seq FROM item_photos ORDER BY id")
echo "  item_photos=${PHOTO_ROWS}행, 파일 API로 받아 SHA-256 비교 ${PHOTO_CHECKED}건 중 불일치 ${PHOTO_BAD}건"
check "사진 파일 API 바이트가 가짜 서버가 보낸 것과 같다" "$([[ "$PHOTO_CHECKED" -ge 1 && "$PHOTO_BAD" == "0" ]] && echo 0 || echo 1)"
stop_pid "$A1_PID"

STATS1="$(curl -fsS "http://127.0.0.1:${FAKE1}/__stats")"
echo "  가짜 서버1이 받은 요청: $(echo "$STATS1" | json 'j.requests') (경로별 $(echo "$STATS1" | json 'JSON.stringify(j.byPath)')), 동시 최대 $(echo "$STATS1" | json 'j.maxConcurrent')"
ROUNDS_C=$(q "SELECT COUNT(*) FROM worker_runs WHERE worker='collector' AND outcome IN ('success','failed','blocked')")
SEARCHES=$(echo "$STATS1" | json 'j.byPath["/pgj/pgjsearch/searchControllerMain.on"] ?? 0')
check "수집 회차 수와 검색 요청 수가 같다(회차당 검색 1)" "$([[ "$SEARCHES" == "$ROUNDS_C" ]] && echo 0 || echo 1)"
# 수집과 사진은 별개 워커(잠금·스레드가 따로)라 한 인스턴스 안에서도 요청이 겹칠 수 있다(TS와 같다). 같은 워커의 동시 요청 없음은 단계 2가 본다.
check "동시 요청 최대 2 이하(수집 1 + 사진 1)" "$([[ "$(echo "$STATS1" | json 'j.maxConcurrent')" -le 2 ]] && echo 0 || echo 1)"

# --------------------------------------------------------------------------------------------------
echo "== 3. 단계 2: Spring 두 개, overlap 건너뜀과 겹침 0 =="
BASE_ID=$(q "SELECT COALESCE(MAX(id),0) FROM worker_runs")
start_fake fake2 --slow-ms 5000
FAKE2="$FAKE_PORT"
write_config "$WORK/collector-2.json" 2000
start_spring a2 "$PORT_A" "$FAKE2" "$WORK/collector-2.json" "$WORK/photos" false
A2_PID="$SPRING_PID"
start_spring b2 "$PORT_B" "$FAKE2" "$WORK/collector-2.json" "$WORK/photos" false
B2_PID="$SPRING_PID"
for _ in $(seq 1 26); do sample_peers "$A2_PID"; sample_peers "$B2_PID"; sleep 1; done
stop_pid "$A2_PID"; stop_pid "$B2_PID"
OV=$(q "SELECT COUNT(*) FROM worker_runs WHERE id > $BASE_ID AND worker='collector' AND outcome='skipped' AND error_kind='overlap'")
OKC=$(q "SELECT COUNT(*) FROM worker_runs WHERE id > $BASE_ID AND worker='collector' AND outcome='success'")
OTHER_SKIP=$(q "SELECT COUNT(*) FROM worker_runs WHERE id > $BASE_ID AND outcome='skipped' AND COALESCE(error_kind,'')<>'overlap'")
OVERLAPPING=$(q "SELECT COUNT(*) FROM worker_runs a JOIN worker_runs b ON a.id < b.id AND a.worker='collector' AND b.worker='collector' AND a.outcome IN ('success','failed','blocked') AND b.outcome IN ('success','failed','blocked') AND a.started_at < b.finished_at AND b.started_at < a.finished_at WHERE a.id > $BASE_ID")
STATS2="$(curl -fsS "http://127.0.0.1:${FAKE2}/__stats")"
echo "  새 회차: 성공 $OKC, overlap 건너뜀 $OV, 그 밖의 건너뜀 $OTHER_SKIP, 실행 구간이 겹친 회차 쌍 $OVERLAPPING"
echo "  가짜 서버2가 받은 요청: $(echo "$STATS2" | json 'j.requests'), 동시 최대 $(echo "$STATS2" | json 'j.maxConcurrent')"
echo "  인스턴스별(로그): a2 회차 시작 $(grep -c '\[collector\] 수집 시작' "$WORK/spring-a2.log" || true)·주기 건너뜀 $(grep -c '이전 회차가 아직 실행 중' "$WORK/spring-a2.log" || true), b2 회차 시작 $(grep -c '\[collector\] 수집 시작' "$WORK/spring-b2.log" || true)·주기 건너뜀 $(grep -c '이전 회차가 아직 실행 중' "$WORK/spring-b2.log" || true)"
check "overlap 건너뜀이 1건 이상" "$([[ "$OV" -ge 1 ]] && echo 0 || echo 1)"
check "성공 회차가 1건 이상(두 인스턴스 합)" "$([[ "$OKC" -ge 1 ]] && echo 0 || echo 1)"
check "실행 구간이 겹친 회차 0쌍" "$([[ "$OVERLAPPING" == "0" ]] && echo 0 || echo 1)"
check "가짜 서버가 본 동시 요청 최대 1(두 인스턴스가 같은 서버에 동시에 요청하지 않았다)" "$([[ "$(echo "$STATS2" | json 'j.maxConcurrent')" == "1" ]] && echo 0 || echo 1)"

# --------------------------------------------------------------------------------------------------
echo "== 4. 요청 대상이 루프백뿐이었는가 =="
LOGS=("$WORK"/spring-*.log)
EXTERNAL_LOG=$(cat "${LOGS[@]}" | grep -c "외부 요청이 허용되지 않았습니다" || true)
URL_HOSTS=$(cat "${LOGS[@]}" | grep -Eo 'https?://[^/ :"]+' | sed -E 's#https?://##' | sort -u || true)
NON_LOOP_URL=$(echo "$URL_HOSTS" | grep -Ev '^(127\.0\.0\.1|localhost|\[::1\])?$' || true)
NON_LOOP_PEER=$(sed -E 's/^->//; s/:[0-9]+$//' "$WORK/peers.txt" 2>/dev/null | sort -u | grep -Ev '^(127\.0\.0\.1|\[::1\]|\[::127\.0\.0\.1\]|\[::ffff:127\.0\.0\.1\]|localhost)$' || true)
PEERS=$(sed -E 's/^->//; s/:[0-9]+$//' "$WORK/peers.txt" 2>/dev/null | sort | uniq -c | tr '\n' ' ')
NON_LOOP_REMOTE=$(cat "$WORK"/fake*.requests.jsonl | node -e 'const l=require("fs").readFileSync(0,"utf8").split("\n").filter(Boolean).map(JSON.parse); const bad=l.filter(r=>!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(r.host)||!/^(127\.0\.0\.1|::ffff:127\.0\.0\.1)$/.test(r.remote)); console.log(bad.length)')
TOTAL_REQ=$(cat "$WORK"/fake*.requests.jsonl | wc -l | tr -d ' ')
echo "  Spring 프로세스 TCP 연결 상대(표본, 연결 수): ${PEERS:-없음}"
echo "  Spring 로그 URL 호스트: $(echo "$URL_HOSTS" | tr '\n' ' ')"
echo "  가짜 서버가 받은 요청 합계 ${TOTAL_REQ}건 중 루프백이 아닌 Host/접속 주소 ${NON_LOOP_REMOTE}건"
grep -h "\[scheduler\] 수집 워커" "${LOGS[@]}" | sed -E 's/^.*(\[scheduler\])/    \1/' | sort -u
check "Spring 로그에 '외부 요청이 허용되지 않았습니다' 0건(어댑터가 외부 호스트로 가려 한 적 없음)" "$([[ "$EXTERNAL_LOG" == "0" ]] && echo 0 || echo 1)"
check "Spring 로그의 URL 호스트가 루프백뿐" "$([[ -z "$NON_LOOP_URL" ]] && echo 0 || echo 1)"
check "Spring 프로세스의 TCP 연결 상대가 루프백뿐(표본 1건 이상)" "$([[ -s "$WORK/peers.txt" && -z "$NON_LOOP_PEER" ]] && echo 0 || echo 1)"
check "가짜 서버가 본 요청이 전부 루프백 Host/접속 주소" "$([[ "$TOTAL_REQ" -ge 1 && "$NON_LOOP_REMOTE" == "0" ]] && echo 0 || echo 1)"
check "로그가 외부 요청 허용 꺼짐으로 시작했다" "$([[ "$(cat "${LOGS[@]}" | grep -c '외부 요청 허용 꺼짐')" -ge 1 ]] && echo 0 || echo 1)"

echo
if [[ "$FAILS" == "0" ]]; then echo "== 전체 통과 =="; else echo "== 실패 ${FAILS}건 =="; exit 1; fi
