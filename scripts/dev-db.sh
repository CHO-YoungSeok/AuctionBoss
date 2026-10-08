#!/usr/bin/env bash
# 로컬 개발용 MySQL 컨테이너를 켜고 끈다. (Spring 백엔드를 IDE나 bootRun으로 띄울 때 쓰는 DB)
#
#   npm run db:up      # 켜기. 컨테이너가 없으면 만들고, 준비될 때까지 기다린다
#   npm run db:down    # 끄기. 데이터는 볼륨에 남는다
#   npm run db:status  # 상태
#
# 접속 정보는 저장소 루트 .env(git 미추적)에서 읽는다: MYSQL_ROOT_PASSWORD, DB_NAME, DB_USER, DB_PASSWORD, DB_PORT.
# docker compose의 mysql 서비스(호스트 3307)와는 별개이고, 이 컨테이너는 DB_PORT(기본 3306)에 연다.
set -euo pipefail

NAME=auctionboss-mysql-dev
VOLUME=auctionboss-mysql-dev-data
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

if [[ -f "$ROOT/.env" ]]; then
  set -a; source "$ROOT/.env"; set +a
fi

exists() { docker container inspect "$NAME" >/dev/null 2>&1; }
running() { [[ "$(docker container inspect -f '{{.State.Running}}' "$NAME" 2>/dev/null)" == "true" ]]; }

wait_ready() {
  for _ in $(seq 1 60); do
    if docker exec "$NAME" mysqladmin ping -h 127.0.0.1 -u"${DB_USER}" -p"${DB_PASSWORD}" --silent >/dev/null 2>&1; then
      echo "준비됨: localhost:${DB_PORT:-3306}/${DB_NAME}"; return 0
    fi
    sleep 2
  done
  echo "MySQL이 120초 안에 준비되지 않았습니다. 'docker logs $NAME'을 확인하세요." >&2; return 1
}

case "${1:-status}" in
  up)
    if running; then echo "이미 켜져 있습니다."; wait_ready; exit 0; fi
    if exists; then
      docker start "$NAME" >/dev/null
    else
      : "${MYSQL_ROOT_PASSWORD:?.env에 MYSQL_ROOT_PASSWORD가 필요합니다}"
      : "${DB_NAME:?.env에 DB_NAME이 필요합니다}" "${DB_USER:?.env에 DB_USER가 필요합니다}" "${DB_PASSWORD:?.env에 DB_PASSWORD가 필요합니다}"
      docker run -d --name "$NAME" -p "127.0.0.1:${DB_PORT:-3306}:3306" \
        -v "$VOLUME:/var/lib/mysql" \
        -e MYSQL_ROOT_PASSWORD -e MYSQL_DATABASE="$DB_NAME" -e MYSQL_USER="$DB_USER" -e MYSQL_PASSWORD="$DB_PASSWORD" \
        mysql:8.4 --character-set-server=utf8mb4 --collation-server=utf8mb4_0900_ai_ci >/dev/null
    fi
    wait_ready
    ;;
  down)
    if running; then docker stop "$NAME" >/dev/null; echo "껐습니다. 데이터는 남아 있습니다."; else echo "이미 꺼져 있습니다."; fi
    ;;
  status)
    if running; then echo "켜짐 (localhost:${DB_PORT:-3306})"; elif exists; then echo "꺼짐 (데이터 보존)"; else echo "없음 ('npm run db:up'으로 만듭니다)"; fi
    ;;
  *)
    echo "사용법: $0 {up|down|status}" >&2; exit 2
    ;;
esac
