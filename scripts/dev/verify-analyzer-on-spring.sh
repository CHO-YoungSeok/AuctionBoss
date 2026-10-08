#!/usr/bin/env bash
# 분석 워커 무수정 연결 검증(openspec add-spring-write-api D11).
# 시드 MySQL + Spring(8080)이 이미 떠 있다는 전제에서, 분석 워커를 환경 변수만 바꿔 1회 실행하고 결과를 확인한다.
#   npm run db:up
#   (cd backend && ./gradlew bootRun --args='--spring.profiles.active=local,seed')   # 다른 터미널
#   bash scripts/dev/verify-analyzer-on-spring.sh [시작커밋]
# 실제 Claude API·CLI는 호출하지 않는다(가짜 CLI). .env 값은 출력하지 않는다.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
BASE="${AUCTIONBOSS_API_BASE:-http://localhost:8080}"
START_COMMIT="${1:-adda943}"
NAME=auctionboss-mysql-dev

if [[ -f .env ]]; then set -a; source .env; set +a; fi
if [[ -n "${ANTHROPIC_API_KEY:-}" ]]; then
  echo "ANTHROPIC_API_KEY가 설정돼 있어 비우고 시작합니다(값은 출력하지 않음)."
fi

q() { docker exec "$NAME" mysql -N -B -u"${DB_USER}" -p"${DB_PASSWORD}" "${DB_NAME}" -e "$1" 2>/dev/null; }

curl -fsS "$BASE/api/items?pageSize=1" >/dev/null || { echo "Spring($BASE)에 연결할 수 없습니다." >&2; exit 1; }

echo "== 실행 전 =="
A0=$(q "SELECT COUNT(*) FROM analyses"); R0=$(q "SELECT COUNT(*) FROM worker_runs WHERE worker='analyzer'")
echo "analyses=$A0 analyzer worker_runs=$R0"
MAXID0=$(q "SELECT COALESCE(MAX(id),0) FROM analyses")

echo "== 분석 워커 1회 실행 =="
START=$(date +%s)
env -u ANTHROPIC_API_KEY \
  AUCTIONBOSS_API_BASE="$BASE" \
  AUCTIONBOSS_CLAUDE_BIN="$ROOT/scripts/dev/fake-claude" \
  AUCTIONBOSS_ANALYZE_MAX=2 AUCTIONBOSS_ANALYZE_REANALYZE_MAX=1 \
  npm run analyzer -- --once
echo "소요 ${SECONDS:-0}s (wall $(( $(date +%s) - START ))s)"

echo "== 실행 후 =="
A1=$(q "SELECT COUNT(*) FROM analyses"); R1=$(q "SELECT COUNT(*) FROM worker_runs WHERE worker='analyzer'")
echo "analyses=$A1 (+$((A1 - A0))) analyzer worker_runs=$R1 (+$((R1 - R0)))"
echo "-- 새 분석 행(id, item_id, model, prompt_version)"
q "SELECT id, item_id, model, prompt_version FROM analyses WHERE id > $MAXID0"
echo "-- 최근 analyzer 회차(id, outcome, detail)"
q "SELECT id, outcome, detail FROM worker_runs WHERE worker='analyzer' ORDER BY id DESC LIMIT 1"
ITEM=$(q "SELECT item_id FROM analyses WHERE id > $MAXID0 ORDER BY id LIMIT 1")
if [[ -n "$ITEM" ]]; then
  echo "-- GET /api/items/$ITEM 의 최신 분석"
  curl -fsS "$BASE/api/items/$ITEM" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);const a=j.latestAnalysis??j.analysis??(j.analyses&&j.analyses[0]);console.log(JSON.stringify(a))})'
fi

echo "== workers/ 코드 변경 (git diff --stat $START_COMMIT -- workers/) =="
git diff --stat "$START_COMMIT" -- workers/
echo "(위가 비어 있으면 코드 변경 0줄)"
