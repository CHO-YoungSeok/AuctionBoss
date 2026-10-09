#!/usr/bin/env bash
# 운영 전환 리허설 (openspec migrate-data-and-cutover D13, tasks 6.x). docs/REFERENCE.md "운영 전환 런북"(9절)·"롤백 런북"(10절)을
# 운영 복사본과 루프백 가짜 소스로 그대로 돌려 시간·건수·해시를 잰다.
#
#   bash scripts/dev/rehearse-cutover.sh <단계>
#     build     이미지 빌드(전환 시간에 넣지 않는다 — 실제 전환도 T0 전에 빌드해 둔다)
#     guard     이전 전 상태에서 운영 구성으로 backend를 띄워 기동 거부(D7)를 확인한다
#     cutover   런북 2~8: 내보내기 -> 드라이런 -> 본 가져오기 -> 검증(API·화면 비교) -> 켬 -> 확인
#     replay    같은 내보내기로 replace 재실행(멱등) -> 해시 대조
#     rollback  롤백 리허설: 차단 응답 1회 -> 델타 보고 -> 상태 내보내기 -> 되쓰기 -> 옛 구성으로 TS 경로 기동
#     clean     리허설 컨테이너·볼륨·임시 파일 전부 정리(운영 자원은 건드리지 않는다)
#
# 격리: compose 프로젝트 auctionboss-rehearsal, 별도 볼륨, 호스트 포트 13000·18080·13307(루프백). 운영 프로젝트 auctionboss의 볼륨과
# 기존 개발 DB 컨테이너(auctionboss-mysql-dev)는 쓰지 않는다. 원본 data/auctionboss.db는 읽기 전용으로만 연다(내보내기의 백업 API).
# 실제 법원 사이트에는 요청하지 않는다(소스 = 사이드카 가짜 서버, 외부 요청 허용 꺼짐). 분석 워커의 claude는 가짜 CLI.
# 비밀: DB 비밀번호는 실행마다 무작위로 만들어 docs/untracked/rehearsal/env.sh(git 무시)에만 두고 출력하지 않는다.
# 출력: 건수·해시·시간·결과 종류만. 값(실명 포함)은 화면에 내지 않는다.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

PROJECT=auctionboss-rehearsal
STATE=docs/untracked/rehearsal
OVERRIDE=scripts/dev/rehearsal.override.yml
SRC_DB=data/auctionboss.db
OLD_COMMIT="${OLD_COMMIT:-8cd214b}"          # 전환 직전 구성 커밋(런북 기록과 같다)
WEB_PORT=13000; BACKEND_PORT=18080; MYSQL_PORT=13307
mkdir -p "$STATE"

if [[ ! -f "$STATE/env.sh" ]]; then
  {
    echo "export DB_NAME=auctionboss_rehearsal DB_USER=rehearsal"
    echo "export DB_PASSWORD=rh-$(openssl rand -hex 12)"
    echo "export MYSQL_ROOT_PASSWORD=rh-root-$(openssl rand -hex 12)"
  } >"$STATE/env.sh"
  chmod 600 "$STATE/env.sh"
fi
# shellcheck disable=SC1091
source "$STATE/env.sh"
# 쉘 환경 변수가 .env보다 우선한다. 운영 .env의 값이 리허설에 섞이지 않게 접속 정보를 모두 덮어쓴다.
export MYSQL_HOST_PORT=$MYSQL_PORT REHEARSAL_MYSQL_PORT=$MYSQL_PORT REHEARSAL_BACKEND_PORT=$BACKEND_PORT REHEARSAL_WEB_PORT=$WEB_PORT
export ANTHROPIC_API_KEY=""   # 실제 Claude 호출 0

dc() { docker compose -p "$PROJECT" -f docker-compose.yml -f "$OVERRIDE" "$@"; }
now_ms() { node -e 'console.log(Date.now())'; }
stamp() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $*" | tee -a "$STATE/times.log"; }
secs() { node -e 'console.log(((process.argv[2]-process.argv[1])/1000).toFixed(1))' "$1" "$2"; }
q() { dc exec -T -e MYSQL_PWD="$DB_PASSWORD" mysql mysql -N -B -r -u"$DB_USER" "$DB_NAME" -e "$1" 2>/dev/null; }
wait_http() { for _ in $(seq 1 "$2"); do curl -fsS -o /dev/null "$1" 2>/dev/null && return 0; sleep 1; done; echo "응답 없음: $1" >&2; return 1; }
sha_src() { { shasum -a 256 "$SRC_DB"; find data/photos -type f -exec shasum -a 256 {} + | sort; } | shasum -a 256 | cut -d' ' -f1; }
exp_dir() { cat "$STATE/exp.path"; }

# 이전 1회 실행 공통: 스케줄러는 반드시 끄고(둘이 켜지면 기동 거부), 내보내기 디렉터리는 읽기 전용으로 마운트한다.
run_once() { # 모드, 추가 -e 인자...
  local mode="$1"; shift
  dc run --rm -T -v "$(exp_dir):/import:ro" \
    -e AUCTIONBOSS_COLLECTOR_ENABLED=false -e AUCTIONBOSS_PHOTOS_ENABLED=false \
    -e AUCTIONBOSS_IMPORT_DIR=/import -e AUCTIONBOSS_RUN_ONCE="$mode" "$@" backend
}

case "${1:-}" in
build)
  s=$(now_ms); dc build; e=$(now_ms); stamp "build 이미지 빌드 $(secs "$s" "$e")s"
  ;;

guard)
  echo "== 이전 전 상태에서 운영 구성 기동(D7 거부 확인) =="
  dc up -d --wait mysql >/dev/null
  rc=0; dc up -d --wait backend web analyzer >"$STATE/guard-up.log" 2>&1 || rc=$?
  echo "  docker compose up 종료 코드=$rc (0이 아니어야 한다)"
  dc ps -a --format '{{.Service}} {{.State}} exit={{.ExitCode}}' | sed 's/^/  /'
  echo "  backend 로그의 기동 거부 줄 수: $(dc logs backend 2>&1 | grep -c '이전 완료 표식' || true)"
  dc logs backend 2>&1 | grep '이전 완료 표식' | head -1 | cut -c1-300 | sed 's/^/  /' || true
  echo "  web·analyzer 실행 중 컨테이너: $(dc ps --status running --format '{{.Service}}' | grep -cE '^(web|analyzer)$' || true) (0이어야 한다)"
  dc rm -sf backend web analyzer >/dev/null 2>&1 || true
  [[ "$rc" != 0 ]]
  ;;

cutover)
  echo "== 런북 1: 사전 확인 =="
  dc config -q && echo "  compose 해석 통과(출력 없음)"
  SRC_BEFORE=$(sha_src); echo "$SRC_BEFORE" >"$STATE/src.sha"; echo "  원본 db+사진 해시(전) ${SRC_BEFORE:0:16}…"
  T0=$(now_ms); stamp "T0 쓰기 정지(리허설에는 멈출 TS 서비스가 없다. 전환 시계 시작)"

  echo "== 런북 3: 백업·내보내기 =="
  s=$(now_ms); npx tsx scripts/migrate/export.ts --source "$SRC_DB" | tee "$STATE/export.log"; e=$(now_ms)
  EXP="$(ls -d "$PWD"/data/migration/*/ | sort | tail -1)"; EXP="${EXP%/}"; echo "$EXP" >"$STATE/exp.path"; echo "$EXP" >>"$STATE/exports.list"
  EXPORT_S=$(secs "$s" "$e"); stamp "내보내기 ${EXPORT_S}s"
  [[ "$(sha_src)" == "$SRC_BEFORE" ]] && echo "  원본 db+사진 해시(후) 동일" || { echo "  원본이 바뀌었다" >&2; exit 1; }

  echo "== 런북 4: 구성 전환(MySQL) =="
  dc up -d --wait mysql >/dev/null

  echo "== 런북 5: 가져오기(드라이런 -> 본 실행) =="
  s=$(now_ms); run_once import -e AUCTIONBOSS_IMPORT_DRY_RUN=true 2>&1 | tee "$STATE/import-dry.log" | grep '^\[import\]\|import' | cut -c1-200; e=$(now_ms)
  DRY_S=$(secs "$s" "$e"); stamp "가져오기 드라이런 ${DRY_S}s"
  s=$(now_ms); run_once import 2>&1 | tee "$STATE/import-1.log" | grep '^\[import\]\|import' | cut -c1-200; e=$(now_ms)
  IMPORT_S=$(secs "$s" "$e"); stamp "가져오기 본 실행 ${IMPORT_S}s"

  echo "== 런북 6: 검증(스케줄러 끈 백엔드) =="
  docker rm -f "$PROJECT-verify" >/dev/null 2>&1 || true
  dc run -d --service-ports --name "$PROJECT-verify" \
    -e AUCTIONBOSS_COLLECTOR_ENABLED=false -e AUCTIONBOSS_PHOTOS_ENABLED=false backend >/dev/null
  wait_http "http://127.0.0.1:$BACKEND_PORT/api/health" 120
  s=$(now_ms)
  npx tsx scripts/migrate/compare-api.ts --source-db "$(exp_dir)/source.db" --spring-base "http://127.0.0.1:$BACKEND_PORT" | tee "$STATE/compare-api-1.log" | cut -c1-200 || true
  e=$(now_ms); stamp "API 비교 $(secs "$s" "$e")s"
  s=$(now_ms)
  SQLITE_DB="$(exp_dir)/source.db" SPRING_BASE="http://127.0.0.1:$BACKEND_PORT" SKIP_FORMS=1 \
    bash scripts/dev/compare-screens.sh 2>&1 | tee "$STATE/compare-screens-1.log" | tail -15 | cut -c1-200 || true
  e=$(now_ms); stamp "화면 비교 $(secs "$s" "$e")s"
  docker rm -f "$PROJECT-verify" >/dev/null

  echo "== 런북 7: 켬(T1) =="
  T1=$(now_ms); T1_ISO=$(date -u +%Y-%m-%dT%H:%M:%SZ); echo "$T1_ISO" >"$STATE/t1.iso"; stamp "T1 켬"
  dc up -d --wait --remove-orphans backend web analyzer source-fake
  echo "== 런북 8: 확인 =="
  curl -fsS "http://127.0.0.1:$WEB_PORT/api/health" >/dev/null && echo "  웹 헬스 200"
  for p in / /bookmarks /feed /status; do echo "  GET $p -> $(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$WEB_PORT$p")"; done
  ID=$(q "SELECT id FROM items ORDER BY id LIMIT 1"); echo "  GET /items/<id> -> $(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$WEB_PORT/items/$ID")"
  T2=$(now_ms); stamp "T2 확인 끝"
  echo "  다운타임(T2-T0) $(secs "$T0" "$T2")s, T0->T1 $(secs "$T0" "$T1")s, T1->T2 $(secs "$T1" "$T2")s"
  echo "  내보내기 ${EXPORT_S}s, 드라이런 ${DRY_S}s, 가져오기 ${IMPORT_S}s"
  echo "  git diff --stat 분석 워커 경로: $(git diff --stat "$OLD_COMMIT" -- workers/analyzer.ts workers/lib workers/prompts | wc -l | tr -d ' ')줄"
  echo "(첫 수집·사진·분석 회차는 1~2분 뒤 'status'로 본다)"
  ;;

status)
  echo "== 회차(worker, outcome, 건수) =="
  q "SELECT worker, outcome, COUNT(*) FROM worker_runs GROUP BY worker, outcome ORDER BY worker, outcome" | sed 's/^/  /'
  echo "== 최근 회차(id, worker, outcome, started_at, finished_at, detail 앞 120자) =="
  q "SELECT id, worker, outcome, started_at, finished_at, LEFT(COALESCE(detail,''),120) FROM worker_runs ORDER BY id DESC LIMIT 8" | sed 's/^/  /'
  echo "== 건수 =="
  for t in items item_changes analyses worker_runs bookmarks feed_reads collector_state item_photos; do echo "  $t $(q "SELECT COUNT(*) FROM $t")"; done
  echo "== 가짜 서버가 본 요청 =="
  dc exec -T source-fake node -e "fetch('http://127.0.0.1:19090/__stats').then(r=>r.json()).then(j=>console.log(JSON.stringify(j)))" 2>&1 | sed 's/^/  /'
  echo "== 백엔드 컨테이너의 TCP 상대 주소(/proc/net/tcp, 중복 제거) =="
  dc exec -T backend sh -c "cat /proc/net/tcp /proc/net/tcp6 2>/dev/null" | node -e '
    let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const set=new Set();
      for(const l of s.split("\n").slice(0)){const f=l.trim().split(/\s+/);if(f.length<4||f[0]==="sl")continue;
        const [a,p]=f[2].split(":");
        const le=h=>h.match(/../g).reverse().map(x=>parseInt(x,16)).join(".");
        let ip;
        if(a.length===8)ip=le(a);                                        // /proc/net/tcp (IPv4)
        else if(a.length===32&&a.startsWith("0000000000000000FFFF0000"))ip=le(a.slice(24)); // /proc/net/tcp6의 IPv4 매핑 주소(자바 소켓)
        else if(a.length===32&&a==="00000000000000000000000001000000")ip="::1";
        else if(a.length===32&&/^0+$/.test(a))ip="::";
        else if(a.length===32)ip="ipv6:"+a;
        else continue;
        if(ip==="::")continue;
        if(ip!=="0.0.0.0")set.add(ip+":"+parseInt(p,16)+" state="+f[3]);}
      console.log([...set].sort().map(x=>"  "+x).join("\n")||"  (없음)")})'
  echo "== 백엔드 로그: 외부 요청 거절 줄 수 =="
  echo "  $(dc logs backend 2>&1 | grep -c '외부 요청이 허용되지 않았습니다' || true)"
  ;;

replay)
  echo "== 같은 내보내기로 replace 재실행(멱등) =="
  dc stop backend analyzer web source-fake >/dev/null
  q "SELECT updated_at FROM collector_state WHERE \`key\`='migration.completed'" >"$STATE/marker-before.txt"
  q "SELECT \`value\` FROM collector_state WHERE \`key\`='migration.completed'" >"$STATE/marker-value-before.txt"
  s=$(now_ms); run_once import -e AUCTIONBOSS_IMPORT_REPLACE=true 2>&1 | tee "$STATE/import-2.log" | grep 'import' | cut -c1-200; e=$(now_ms)
  stamp "가져오기 replace ${s:+$(secs "$s" "$e")}s"
  q "SELECT updated_at FROM collector_state WHERE \`key\`='migration.completed'" >"$STATE/marker-after.txt"
  q "SELECT \`value\` FROM collector_state WHERE \`key\`='migration.completed'" >"$STATE/marker-value-after.txt"
  echo "  표식 값(해시 요약) 동일: $(cmp -s "$STATE/marker-value-before.txt" "$STATE/marker-value-after.txt" && echo 예 || echo 아니오)"
  echo "  표식 시각 갱신: $(cmp -s "$STATE/marker-before.txt" "$STATE/marker-after.txt" && echo 아니오 || echo 예)"
  ;;

rollback)
  # 롤백 리허설(D11, REFERENCE 10절). 원본 data/는 복사본(rollback-data)으로만 다룬다. 옛 TS 수집기·사진 워커는 네트워크를 끊고 띄운다.
  RB="$STATE/rollback-data"
  sdb() { sqlite3 "$RB/auctionboss.db" "$1"; }   # 복사본이라 쓰기 모드로 열어도 된다(WAL 공유 메모리 파일을 만들 수 있어야 한다)
  dco() { git show "$OLD_COMMIT:docker-compose.yml" | docker compose -p "$PROJECT-old" --project-directory . -f - -f scripts/dev/rehearsal-rollback.override.yml "$@"; }
  echo "== 준비(시간 재지 않음): 전환 상태 켜기, 가짜 서버 차단 1회, 옛 구성 이미지·빈 옛 볼륨 =="
  dc up -d --wait backend web analyzer source-fake >/dev/null 2>&1
  T1B=$(date -u +%Y-%m-%dT%H:%M:%SZ); echo "$T1B" >"$STATE/t1b.iso"; echo "  전환 시각(델타 기준) $T1B"
  for _ in $(seq 1 100); do [[ "$(q "SELECT COUNT(*) FROM worker_runs WHERE worker='collector' AND outcome='success' AND id>10")" -ge 1 ]] && break; sleep 2; done
  echo "  Spring 수집 성공 회차(전환 뒤): $(q "SELECT COUNT(*) FROM worker_runs WHERE worker='collector' AND outcome='success' AND id>10")"
  dc exec -T source-fake node -e "fetch('http://127.0.0.1:19090/__block?n=1').then(r=>r.text()).then(t=>console.log('  가짜 서버 차단 예약', t))" 2>/dev/null
  for _ in $(seq 1 100); do [[ "$(q "SELECT COUNT(*) FROM worker_runs WHERE worker='collector' AND outcome='blocked'")" -ge 1 ]] && break; sleep 2; done
  echo "  차단 회차: $(q "SELECT COUNT(*) FROM worker_runs WHERE worker='collector' AND outcome='blocked'")건, MySQL backoff 키: $(q "SELECT CONCAT(\`key\`,' ',\`value\`) FROM collector_state WHERE \`key\` LIKE '%backoff%'")"
  rm -rf "$RB"; mkdir -p "$RB"; cp -p "$SRC_DB" "$RB/auctionboss.db"; cp -pR data/photos "$RB/photos"
  echo "  원본 복사본 생성(이 단계 이후 원본 data/는 열지 않는다)"
  echo "  SQLite(복사본) 되쓰기 전: backoff=[$(sdb "SELECT value FROM collector_state WHERE key LIKE '%backoff%'")] rotation=[$(sdb "SELECT value FROM collector_state WHERE key LIKE '%rotation%'")]"
  dco build >/dev/null 2>&1
  # 현실과 같게: 옛 볼륨에는 빈 DB가 이미 있다(옛 web을 한 번 띄워 만든다).
  dco up -d --wait web >/dev/null 2>&1; dco stop web >/dev/null 2>&1
  VOL="${PROJECT}-old_auctionboss-data"
  echo "  옛 볼륨 $VOL 내용(복사 전): $(docker run --rm -v "$VOL":/d:ro alpine sh -c 'ls -A /d | tr "\n" " "')"

  echo "== 롤백 시작(시계) =="
  RB0=$(now_ms); stamp "롤백 시작"
  echo "-- 롤백 1: 수집·쓰기 멈추기"
  dc stop backend analyzer web source-fake >/dev/null 2>&1
  stamp "롤백 1 끝(백엔드·분석·웹·가짜 서버 정지)"
  echo "-- 롤백 2: 델타 보고(전환 시각 $T1B 이후)"
  run_once delta-report -e AUCTIONBOSS_DELTA_SINCE="$T1B" 2>&1 | grep '^{"since"' | tee "$STATE/delta.json"
  echo "-- 롤백 3: 상태 내보내기"
  run_once export-state 2>&1 | grep '^{"backoffUntil"' >"$STATE/state.json"; cat "$STATE/state.json"
  echo "-- 롤백 4: 상태 되쓰기(대상은 원본의 복사본)"
  npx tsx scripts/migrate/rollback-state.ts --sqlite "$RB/auctionboss.db" --state "$STATE/state.json"
  echo "  SQLite(복사본) 되쓴 뒤: backoff=[$(sdb "SELECT value FROM collector_state WHERE key LIKE '%backoff%'")] rotation=[$(sdb "SELECT value FROM collector_state WHERE key LIKE '%rotation%'")]"
  echo "-- 롤백 5: 옛 구성 기동(옛 볼륨 복사 단계 포함)"
  if [[ -n "$(dc ps --status running --format '{{.Service}}' | grep -E '^backend$' || true)" ]]; then echo "백엔드가 실행 중입니다" >&2; exit 1; fi
  echo "  backend 실행 중 아님"
  # REFERENCE 10절 5의 명령과 같다(소스 경로만 복사본). 옛 볼륨의 빈 DB와 WAL·SHM을 먼저 지우고, 파일 소유자를 web의 node(1000)로 맞춘다.
  docker run --rm -v "$VOL":/dest -v "$PWD/$RB":/src:ro alpine sh -c '
    set -e
    rm -f /dest/auctionboss.db /dest/auctionboss.db-wal /dest/auctionboss.db-shm
    cp /src/auctionboss.db /dest/auctionboss.db
    [ -f /src/auctionboss.db-wal ] && cp /src/auctionboss.db-wal /dest/auctionboss.db-wal
    [ -d /src/photos ] && cp -R /src/photos /dest/
    chown -R 1000:1000 /dest'
  stamp "롤백 5-a 볼륨 복사 끝"
  dco up -d --wait web collector photos analyzer 2>&1 | grep -v 'level=warning' | tail -4
  RB1=$(now_ms); stamp "롤백 5-b 옛 구성 기동 끝"
  echo "롤백 소요(정지 시작 -> 옛 구성 healthy) $(secs "$RB0" "$RB1")s"
  echo "== 롤백 확인 =="
  echo "  옛 web 헬스: $(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:13001/api/health)"
  for p in / /bookmarks /feed /status; do echo "  GET $p -> $(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:13001$p")"; done
  echo "  옛 구성이 본 SQLite(옛 web 컨테이너 안, 읽기 전용): 건수와 최근 회차"
  docker exec "$PROJECT-old-web-1" node -e '
    const D=require("better-sqlite3");const db=new D("/app/data/auctionboss.db",{readonly:true});
    for(const t of ["items","item_changes","analyses","worker_runs","item_photos"])console.log("   ",t,db.prepare("select count(*) c from "+t).get().c);
    for(const r of db.prepare("select id,worker,outcome,started_at from worker_runs order by id desc limit 4").all())console.log("    run",r.id,r.worker,r.outcome,r.started_at);
    for(const r of db.prepare("select key,value from collector_state").all())console.log("    state",r.key,r.value);'
  echo "  옛 collector 로그(백오프 줄·요청 시도 줄 수):"
  echo "    백오프로 건너뜀: $(docker logs "$PROJECT-old-collector-1" 2>&1 | grep -c '백오프 중이라 건너뜁니다' || true), 네트워크 오류(요청 시도): $(docker logs "$PROJECT-old-collector-1" 2>&1 | grep -c 'EAI_AGAIN\|getaddrinfo' || true), 읽기 전용 오류: $(docker logs "$PROJECT-old-collector-1" 2>&1 | grep -c 'readonly' || true)"
  echo "  옛 photos 로그 읽기 전용 오류: $(docker logs "$PROJECT-old-photos-1" 2>&1 | grep -c 'READONLY\|readonly' || true)"
  ;;

backoff-check)
  # 이전된 백오프가 Spring 수집기에 이어지는지(D11 "잃으면 안 되는 것"의 반대 방향): 백오프가 들어 있는 SQLite 복사본(rollback 단계 산출물)을
  # 내보내 replace로 가져온 뒤 백엔드를 켜고, 첫 수집·사진 틱이 요청 없이 건너뛰는지 가짜 서버 요청 수로 확인한다.
  RB="$STATE/rollback-data"
  [[ -f "$RB/auctionboss.db" ]] || { echo "rollback 단계를 먼저 하세요" >&2; exit 2; }
  dc stop backend analyzer web source-fake >/dev/null 2>&1
  echo "  복사본의 backoff_until: $(sqlite3 "$RB/auctionboss.db" "SELECT value FROM collector_state WHERE key='backoff_until'")"
  npx tsx scripts/migrate/export.ts --source "$RB/auctionboss.db" | grep -v '^  ' | head -3
  ls -d "$PWD"/data/migration/*/ | sort | tail -1 | sed 's:/$::' >"$STATE/exp.path"
  cat "$STATE/exp.path" >>"$STATE/exports.list"
  run_once import -e AUCTIONBOSS_IMPORT_REPLACE=true 2>&1 | grep -E '검증 collector_state|종료 코드|성공' | cut -c60-220
  echo "  MySQL backoff: $(q "SELECT \`value\` FROM collector_state WHERE \`key\`='backoff_until'")"
  dc up -d --wait backend source-fake >/dev/null 2>&1
  B0=$(dc exec -T source-fake node -e "fetch('http://127.0.0.1:19090/__stats').then(r=>r.json()).then(j=>console.log(j.requests))" 2>/dev/null)
  echo "  기동 직후 가짜 서버 요청 수 $B0, 2분 대기 중(주기 1분 틱 2번)..."
  for _ in $(seq 1 130); do sleep 1; done
  B1=$(dc exec -T source-fake node -e "fetch('http://127.0.0.1:19090/__stats').then(r=>r.json()).then(j=>console.log(j.requests))" 2>/dev/null)
  echo "  2분 뒤 요청 수 $B1 (늘지 않아야 한다)"
  q "SELECT id, worker, outcome FROM worker_runs WHERE id>10 ORDER BY id" | sed 's/^/  run /'
  ;;

clean)
  docker rm -f "$PROJECT-verify" >/dev/null 2>&1 || true
  dc down -v --remove-orphans 2>&1 | tail -3 || true
  git show "$OLD_COMMIT:docker-compose.yml" | docker compose -p "$PROJECT-old" --project-directory . -f - -f scripts/dev/rehearsal-rollback.override.yml down -v --remove-orphans >/dev/null 2>&1 || true
  # 리허설이 만든 내보내기 디렉터리만 지운다(exports.list). 실제 전환의 data/migration/<시각>/은 롤백 기준이라 건드리지 않는다.
  if [[ -f "$STATE/exports.list" ]]; then
    while IFS= read -r d; do [[ -n "$d" && "$d" == "$PWD"/data/migration/* ]] && rm -rf "$d"; done <"$STATE/exports.list"
  fi
  rm -rf "$STATE"
  echo "정리 완료"
  ;;

*)
  sed -n 2,16p "$0"; exit 2 ;;
esac
