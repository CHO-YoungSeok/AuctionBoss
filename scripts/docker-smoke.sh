#!/usr/bin/env bash
# compose(mysql + backend) 기동 스모크: 처음 기동 -> 재기동 후 데이터 유지 -> 정리.
# 사용: scripts/docker-smoke.sh   (환경 변수 EXPECTED_TOTAL로 기대 건수 변경, 기본 809)
# 주의: 끝에 `docker compose down -v`로 이 프로젝트의 mysql-data 볼륨을 지운다.
set -euo pipefail
cd "$(dirname "$0")/.."
EXPECTED_TOTAL="${EXPECTED_TOTAL:-809}"
BASE=http://localhost:8080

cleanup() { docker compose down -v >/dev/null 2>&1 || true; }
trap cleanup EXIT

wait_health() {
  for _ in $(seq 1 60); do
    [ "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/health")" = 200 ] && return 0
    sleep 3
  done
  echo "FAIL: /api/health가 200을 돌려주지 않음"; docker compose logs backend | tail -40; exit 1
}
check_total() {
  local total
  total=$(curl -fsS "$BASE/api/items?pageSize=1" | python3 -c 'import json,sys;print(json.load(sys.stdin)["total"])')
  [ "$total" = "$EXPECTED_TOTAL" ] || { echo "FAIL: total=$total (기대 $EXPECTED_TOTAL)"; exit 1; }
  echo "OK: total=$total"
}

echo "== 1. 처음 기동 (빈 볼륨) =="
docker compose down -v >/dev/null 2>&1 || true
docker compose up -d --build --wait mysql backend
wait_health; check_total
logs=$(docker compose logs backend 2>&1)
grep -q "시드 .*개 파일을 적재했습니다" <<<"$logs" || { echo "FAIL: 시드 적재 로그 없음"; exit 1; }

echo "== 2. 재기동 (볼륨 유지) =="
docker compose down
docker compose up -d --wait mysql backend
wait_health; check_total
logs=$(docker compose logs backend 2>&1)
grep -q "이미 .*건이 있어 시드를 적재하지 않습니다" <<<"$logs" || { echo "FAIL: 건너뜀 로그 없음(중복 적재 의심)"; exit 1; }
echo "OK: 시드 중복 적재 없음"
echo "== 완료 =="
