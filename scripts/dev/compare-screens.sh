#!/usr/bin/env bash
# 개발 환경 spring 모드 화면 비교 (openspec switch-web-to-data-port D9, tasks 8.1~8.3).
#
# 같은 시드로 만든 두 원천(임시 MySQL+Spring, 임시 SQLite)에 Next 인스턴스 둘을 붙이고, 같은 순서로
# 폼 동작을 보낸 뒤 화면 HTML을 받아 diff한다. CI에는 넣지 않는다(Docker·JDK·Next 빌드가 필요).
#
#   bash scripts/dev/compare-screens.sh            # 전체(비교 + 응답 시간 + Spring 중단 확인)
#   SHOT_DIR=docs/untracked/stage3-spring-mode bash scripts/dev/compare-screens.sh   # 스크린숏도 저장
#
# 하는 일
#  1. 임시 mysql:8.4 컨테이너(별도 포트·별도 볼륨 없음)를 띄우고 Spring(local,seed 프로필)을 jar로 띄운다.
#     기존 개발 DB(auctionboss-mysql-dev, 볼륨)는 건드리지 않는다. 시드는 비어 있는 DB에 Flyway 뒤 SeedLoader가 넣는다.
#  2. 같은 시드 SQL로 임시 SQLite를 만든다(scripts/seed/seed-to-sqlite.ts). 원본 운영 DB는 열지 않는다.
#  3. next build 1회, next start 둘:
#       SQLITE_PORT : AUCTIONBOSS_DATA_SOURCE=sqlite, AUCTIONBOSS_DB=임시 SQLite
#       SPRING_PORT : AUCTIONBOSS_DATA_SOURCE=spring, AUCTIONBOSS_SPRING_BASE=임시 Spring,
#                     AUCTIONBOSS_DB=존재하지 않는 디렉터리 아래 경로(SQLite를 열려 하면 실패하고, 끝에 경로가 여전히 없어야 한다)
#  4. 단계 A(쓰기 전): 화면 5개와 변형을 두 인스턴스에서 받는다.
#     단계 B: 폼 동작을 두 인스턴스에 "같은 순서"로 보낸다(관심 3건 등록 -> 1건 해제 -> 읽음 처리).
#     단계 C(쓰기 후): 변형을 다시 받는다.
#  5. 정규화 후 diff. 차이 1건이라도 있으면 종료 코드 1.
#  6. 화면별 응답 시간(워밍업 1회 + 반복 N회 중앙값/최댓값).
#  7. 8.3: Spring을 멈추고 spring 인스턴스 화면이 오류로 끝나는지, SQLite 데이터가 보이지 않는지 확인.
#  8. 모두 정리(Next 둘, Spring, 임시 컨테이너, 임시 디렉터리). 비밀 값은 출력하지 않는다(임시 컨테이너 전용 값만 쓴다).
#
# 정규화 규칙(scripts/dev/normalize-html.py, 근거는 그 파일 머리말). "동작 차이"를 숨기는 규칙은 두지 않는다.
#  N1. Next 빌드 ID 경로 -> BUILD (같은 빌드라 원래 같다. 다른 빌드로 비교해도 되게 한 것).
#  N2. 스트리밍 조각(`self.__next_f.push`)은 이어 붙여 해석한 뒤 조각 번호·참조 번호(`4:`, `$L10`)를 지우고 줄을 정렬해 비교한다.
#      sqlite 모드는 데이터가 동기로 와서 한 덩어리로, spring 모드는 비동기로 와서 여러 조각으로 나뉘는데(내용 같음) 번호와
#      순서만 다르다. 값(문자열·속성·숫자)은 그대로 비교한다. 이 규칙 없이는 35건 중 33건이 "다름"으로 나온다(실측).
#  N3. Suspense 완료 스크립트의 `B:n`/`S:n` 번호를 `#`으로 바꾼다.
#  화면에 보이는 DOM(조각이 아닌 부분)은 한 글자도 바꾸지 않는다.
#  시각 의존 문구(경과 시간·D-day·담은 시각)는 정규화하지 않는다. 같은 URL을 두 인스턴스에 연달아(sqlite -> spring) 보내
#  "지금"의 차이를 수 ms로 줄이고, 차이가 나오면 사람이 원인을 본다(이번 실행에서는 0건이었다).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

SQLITE_PORT="${SQLITE_PORT:-3100}"
SPRING_PORT="${SPRING_PORT:-3101}"
BACKEND_PORT="${BACKEND_PORT:-8089}"
MYSQL_PORT="${CMP_MYSQL_PORT:-3399}"
REPEAT="${REPEAT:-10}"
SHOT_DIR="${SHOT_DIR:-}"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/auctionboss-compare.XXXXXX")"
CONTAINER="auctionboss-compare-mysql-$$"
# 임시 컨테이너 전용 값이다(저장소 .env의 값이 아니다).
CMP_DB_NAME="auctionboss_cmp"; CMP_DB_USER="cmp"; CMP_DB_PASSWORD="cmp-pass-$$"; CMP_ROOT_PASSWORD="cmp-root-$$"
SQLITE_DB="$WORK/sqlite/seed.db"
NO_DB_DIR="$WORK/no-such-dir"
NO_DB="$NO_DB_DIR/auctionboss.db"
OUT="$WORK/out"; mkdir -p "$OUT/a-sqlite" "$OUT/a-spring" "$OUT/c-sqlite" "$OUT/c-spring" "$WORK/sqlite"
PIDS=()

cleanup() {
  set +e
  for p in "${PIDS[@]:-}"; do [[ -n "$p" ]] && kill "$p" 2>/dev/null; done
  sleep 1
  for p in "${PIDS[@]:-}"; do [[ -n "$p" ]] && kill -9 "$p" 2>/dev/null; done
  docker rm -f "$CONTAINER" >/dev/null 2>&1
  if [[ -n "${KEEP_WORK:-}" ]]; then echo "임시 디렉터리 보존: $WORK"; else rm -rf "$WORK"; fi
}
trap cleanup EXIT

for port in "$SQLITE_PORT" "$SPRING_PORT" "$BACKEND_PORT" "$MYSQL_PORT"; do
  if lsof -iTCP:"$port" -sTCP:LISTEN -nP >/dev/null 2>&1; then echo "포트 $port가 이미 쓰이고 있습니다. 환경 변수로 다른 포트를 지정하세요." >&2; exit 2; fi
done

wait_http() { # url, 초
  for _ in $(seq 1 "$2"); do curl -fsS -o /dev/null "$1" 2>/dev/null && return 0; sleep 1; done
  echo "응답 없음: $1" >&2; return 1
}

echo "== 1. 임시 MySQL + Spring =="
docker run -d --name "$CONTAINER" -p "127.0.0.1:${MYSQL_PORT}:3306" \
  -e MYSQL_ROOT_PASSWORD="$CMP_ROOT_PASSWORD" -e MYSQL_DATABASE="$CMP_DB_NAME" -e MYSQL_USER="$CMP_DB_USER" -e MYSQL_PASSWORD="$CMP_DB_PASSWORD" \
  mysql:8.4 --character-set-server=utf8mb4 --collation-server=utf8mb4_0900_ai_ci >/dev/null
for _ in $(seq 1 60); do
  docker exec "$CONTAINER" mysqladmin ping -h 127.0.0.1 -u"$CMP_DB_USER" -p"$CMP_DB_PASSWORD" --silent >/dev/null 2>&1 && break; sleep 2
done
(cd backend && ./gradlew bootJar -x test --console=plain -q)
JAR="$(ls -t backend/build/libs/*.jar | grep -v plain | head -1)"
# 환경 변수가 저장소 .env(spring.config.import)보다 우선한다. 접속 정보는 임시 컨테이너 것만 쓴다.
DB_HOST=127.0.0.1 DB_PORT="$MYSQL_PORT" DB_NAME="$CMP_DB_NAME" DB_USER="$CMP_DB_USER" DB_PASSWORD="$CMP_DB_PASSWORD" \
  SERVER_PORT="$BACKEND_PORT" SPRING_PROFILES_ACTIVE=local,seed \
  java -jar "$JAR" >"$WORK/spring.log" 2>&1 &
SPRING_PID=$!; PIDS+=("$SPRING_PID")
wait_http "http://127.0.0.1:${BACKEND_PORT}/api/items?pageSize=1" 120

echo "== 2. 같은 시드의 임시 SQLite =="
npx tsx -e 'import { seedToSqlite } from "./scripts/seed/seed-to-sqlite"; console.log(JSON.stringify(seedToSqlite(process.argv[1])))' "$SQLITE_DB"

echo "== 3. next build, next start 둘 =="
npx next build >"$WORK/build.log" 2>&1 || { tail -30 "$WORK/build.log"; exit 1; }
AUCTIONBOSS_DATA_SOURCE=sqlite AUCTIONBOSS_DB="$SQLITE_DB" npx next start -p "$SQLITE_PORT" >"$WORK/next-sqlite.log" 2>&1 &
PIDS+=("$!")
AUCTIONBOSS_DATA_SOURCE=spring AUCTIONBOSS_SPRING_BASE="http://127.0.0.1:${BACKEND_PORT}" AUCTIONBOSS_DB="$NO_DB" \
  npx next start -p "$SPRING_PORT" >"$WORK/next-spring.log" 2>&1 &
PIDS+=("$!")
S="http://127.0.0.1:${SQLITE_PORT}"; P="http://127.0.0.1:${SPRING_PORT}"
wait_http "$S/bookmarks" 60; wait_http "$P/bookmarks" 60

# 화면 목록: 이름|경로. 상세 id는 시드 기준(1 분석 있음, 3 분석 없음·사진 대기, 2 사진 조회 불가).
SCREENS=(
  "list-default|/"
  "list-sort-page2|/?sort=minBidPrice&dir=desc&page=2"
  "list-filter-usage-failed|/?usage=%EC%83%81%EA%B0%80,%EC%98%A4%ED%94%BC%EC%8A%A4%ED%85%94,%EA%B7%BC%EB%A6%B0%EC%8B%9C%EC%84%A4&minFailed=1"
  "list-filter-sido-court|/?sido=%EC%84%9C%EC%9A%B8%ED%8A%B9%EB%B3%84%EC%8B%9C&court=%EC%84%9C%EC%9A%B8%EC%A4%91%EC%95%99%EC%A7%80%EB%B0%A9%EB%B2%95%EC%9B%90&sort=bidRatio"
  "list-analyzed|/?analyzed=true"
  "list-empty-filtered|/?q=%EC%A1%B4%EC%9E%AC%ED%95%98%EC%A7%80%EC%95%8A%EB%8A%94%EC%A3%BC%EC%86%8C%ED%82%A4%EC%9B%8C%EB%93%9C"
  "list-lenient-garbage|/?sort=nope&minPrice=abc&page=0"
  "detail-analyzed|/items/1"
  "detail-no-analysis-photo-pending|/items/3"
  "detail-photo-unavailable|/items/2"
  "detail-not-found|/items/999999"
  "detail-bad-id|/items/abc"
  "bookmarks|/bookmarks"
  "feed|/feed"
  "status|/status"
)
# 쓰기 후에만 받는 변형(관심 목록 필터, 피드 2페이지 등).
SCREENS_C_ONLY=(
  "list-bookmarked|/?bookmarked=true"
  "bookmarks-page2|/bookmarks?page=2"
  "feed-page2|/feed?page=2"
)

# 정규화. 규칙을 더하려면 normalize-html.py 머리말과 위 주석에 근거를 먼저 적는다.
normalize() { python3 "$ROOT/scripts/dev/normalize-html.py"; }

fetch_pair() { # 단계 이름|경로 목록을 두 인스턴스에서 연달아 받는다(sqlite -> spring)
  local phase="$1"; shift
  local entry name path
  for entry in "$@"; do
    name="${entry%%|*}"; path="${entry#*|}"
    curl -sS -o "$OUT/$phase-sqlite/$name.html" -w '%{http_code}\n' "$S$path" >"$OUT/$phase-sqlite/$name.code"
    curl -sS -o "$OUT/$phase-spring/$name.html" -w '%{http_code}\n' "$P$path" >"$OUT/$phase-spring/$name.code"
  done
}

echo "== 4A. 쓰기 전 화면 =="
fetch_pair a "${SCREENS[@]}"

echo "== 4B. 폼 동작(같은 순서, 두 인스턴스) =="
# 변경 이력이 많은 물건 3건을 고른다(시드 SQLite 기준). 등록 3건 -> 첫째 해제 -> 읽음 처리.
IDS=($(sqlite3 "$SQLITE_DB" "SELECT item_id FROM item_changes GROUP BY item_id ORDER BY COUNT(*) DESC, item_id LIMIT 3"))
echo "관심 대상 물건: ${IDS[*]}"
post() { # base, 경로, 본문 -> HTTP 코드
  curl -sS -o /dev/null -w '%{http_code}' -X POST --data "$3" "$1$2"
}
form_step() {
  local label="$1" path="$2" body="$3" a b
  a="$(post "$S" "$path" "$body")"; b="$(post "$P" "$path" "$body")"
  echo "  $label: sqlite=$a spring=$b"
  [[ "$a" == "$b" ]] || { echo "폼 응답 코드가 다릅니다: $label" >&2; FORM_MISMATCH=1; }
}
FORM_MISMATCH=0
for id in "${IDS[@]}"; do form_step "관심 등록 $id" /api/bookmarks/toggle "itemId=$id&bookmarked=false&returnTo=%2Fbookmarks"; done
form_step "관심 해제 ${IDS[0]}" /api/bookmarks/toggle "itemId=${IDS[0]}&bookmarked=true&returnTo=%2Fbookmarks"
# 읽음 처리 전 화면(미확인이 남은 상태)도 받는다.
mkdir -p "$OUT/b-unread-sqlite" "$OUT/b-unread-spring"
fetch_pair b-unread "feed-unread|/feed" "status-after-bookmark|/status"
form_step "읽음 처리" /api/feed/mark-read "returnTo=%2Ffeed"

echo "== 4C. 쓰기 후 화면 =="
fetch_pair c "${SCREENS[@]}" "${SCREENS_C_ONLY[@]}"

echo "== 5. 정규화 후 diff =="
DIFFS=0; COUNT=0
for phase in a b-unread c; do
  for f in "$OUT/$phase-sqlite/"*.html; do
    name="$(basename "$f" .html)"; COUNT=$((COUNT + 1))
    normalize <"$f" >"$f.norm"; normalize <"$OUT/$phase-spring/$name.html" >"$OUT/$phase-spring/$name.html.norm"
    if ! diff -q "$f.norm" "$OUT/$phase-spring/$name.html.norm" >/dev/null || ! diff -q "$OUT/$phase-sqlite/$name.code" "$OUT/$phase-spring/$name.code" >/dev/null; then
      DIFFS=$((DIFFS + 1)); echo "  차이: $phase/$name (sqlite $(tr -d '\n' <"$OUT/$phase-sqlite/$name.code") / spring $(tr -d '\n' <"$OUT/$phase-spring/$name.code"))"
      diff "$f.norm" "$OUT/$phase-spring/$name.html.norm" | head -c 600 || true
    fi
  done
done
echo "비교 ${COUNT}건, 차이 ${DIFFS}건, 폼 응답 코드 불일치 ${FORM_MISMATCH}건"

echo "== 6. 화면별 응답 시간(ms, 워밍업 1회 제외, ${REPEAT}회) =="
median_max() { # 초 단위 값 여러 줄 -> "median max" (ms)
  sort -n | awk '{a[NR]=$1} END{m=(NR%2)?a[(NR+1)/2]:(a[NR/2]+a[NR/2+1])/2; printf "%.0f %.0f", m*1000, a[NR]*1000}'
}
timing() { # base, 경로
  curl -sS -o /dev/null "$1$2"
  for _ in $(seq 1 "$REPEAT"); do curl -sS -o /dev/null -w '%{time_total}\n' "$1$2"; done | median_max
}
printf '%-34s %12s %12s\n' "화면" "sqlite(중앙/최대)" "spring(중앙/최대)"
for entry in "${SCREENS[@]}"; do
  name="${entry%%|*}"; path="${entry#*|}"
  s="$(timing "$S" "$path")"; p="$(timing "$P" "$path")"
  printf '%-34s %8s/%-6s %8s/%-6s\n' "$name" "${s% *}" "${s#* }" "${p% *}" "${p#* }"
done

if [[ -n "$SHOT_DIR" ]]; then
  CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  if [[ -x "$CHROME" ]]; then
    echo "== 스크린숏 -> $SHOT_DIR =="
    mkdir -p "$SHOT_DIR"
    for entry in "list-default|/" "detail-analyzed|/items/1" "bookmarks|/bookmarks" "feed|/feed" "status|/status"; do
      name="${entry%%|*}"; path="${entry#*|}"
      for mode in sqlite spring; do
        base="$S"; [[ "$mode" == spring ]] && base="$P"
        "$CHROME" --headless=new --disable-gpu --hide-scrollbars --window-size=1280,1600 \
          --screenshot="$SHOT_DIR/$name-$mode.png" "$base$path" >/dev/null 2>&1 || echo "  스크린숏 실패: $name-$mode"
      done
    done
  else
    echo "Chrome이 없어 스크린숏을 건너뜁니다."
  fi
fi

echo "== 7. SQLite를 열지 않았는지 =="
if [[ -e "$NO_DB" || -e "$NO_DB_DIR" || -e "$NO_DB-wal" ]]; then echo "실패: spring 인스턴스가 SQLite 경로를 만들었습니다: $NO_DB_DIR"; NO_DB_OPENED=1; else echo "통과: $NO_DB_DIR 가 계속 없습니다."; NO_DB_OPENED=0; fi

echo "== 8. 8.3 Spring 중단 후 spring 인스턴스 =="
kill "$SPRING_PID" 2>/dev/null || true; wait "$SPRING_PID" 2>/dev/null || true
STOP_FAIL=0
for entry in "list-default|/" "detail-analyzed|/items/1" "bookmarks|/bookmarks" "feed|/feed" "status|/status"; do
  name="${entry%%|*}"; path="${entry#*|}"
  code="$(curl -sS -m 20 -o "$OUT/stopped-$name.html" -w '%{http_code}' "$P$path")"
  # 시드 물건의 주소가 화면에 보이면(SQLite 데이터가 보이면) 실패. 시드 물건 1의 사건번호를 기준으로 쓴다.
  leak="$(grep -c "$(sqlite3 "$SQLITE_DB" 'SELECT case_no FROM items WHERE id=1')" "$OUT/stopped-$name.html" || true)"
  echo "  $path -> HTTP $code, 시드 데이터 노출 ${leak}회"
  [[ "$code" =~ ^5 ]] && [[ "$leak" == "0" ]] || STOP_FAIL=1
done
[[ "$(sqlite3 "$SQLITE_DB" 'SELECT COUNT(*) FROM items')" -gt 0 ]] || { echo "SQLite 시드가 비어 있어 확인이 무의미합니다" >&2; STOP_FAIL=1; }
echo "Spring 중단 확인: $([[ $STOP_FAIL == 0 ]] && echo 통과 || echo 실패)"
echo "-- spring 인스턴스 로그 끝(오류 형태 확인용)"; tail -5 "$WORK/next-spring.log" | cut -c1-200

[[ "$DIFFS" == 0 && "$FORM_MISMATCH" == 0 && "$NO_DB_OPENED" == 0 && "$STOP_FAIL" == 0 ]]
