#!/usr/bin/env bash
# Runs the whole local stack against MOCK Pinterest: mock API (4010) + mock sites (4011), analytics (8000),
# Next.js (3000) and the job worker. Requires Postgres (docker compose up postgres) and apps/web/.env.local.
# Usage: scripts/dev-stack.sh [--prod]   (--prod runs `next build && next start` instead of `next dev`)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOG="${TMPDIR:-/tmp}/pinpulse-stack"; mkdir -p "$LOG"
# Kill each background job's whole process tree (pnpm/uvicorn children otherwise outlive the script and keep ports).
tree() { local c; echo "$1"; for c in $(pgrep -P "$1" 2>/dev/null); do tree "$c"; done; }
cleanup() {
  local pids; pids="$(for j in $(jobs -p); do tree "$j"; done)"
  [ -n "$pids" ] || return 0
  kill $pids 2>/dev/null || true
  for _ in 1 2 3 4 5 6 7 8 9 10; do kill -0 $pids 2>/dev/null || return 0; sleep 0.5; done
  kill -9 $pids 2>/dev/null || true
}
trap cleanup EXIT

cd "$ROOT/apps/web"
[ -f .env.local ] || { echo "apps/web/.env.local missing — copy .env.example and fill BETTER_AUTH_SECRET/TOKEN_KEK_V1"; exit 1; }
set -a; . ./.env.local; set +a

( cd "$ROOT/services/pinterest-mock" && MOCK_SITE_BASE=http://127.0.0.1:4011 MOCK_RATE_ANALYTICS_PER_MIN=${MOCK_RATE_ANALYTICS_PER_MIN:-600} pnpm exec tsx src/cli.ts >"$LOG/mock.log" 2>&1 ) &
# Same ANALYTICS_TOKEN as the web app (from .env.local); required by `next start` (--prod), optional for `next dev`.
( cd "$ROOT/services/analytics" && ANALYTICS_TOKEN="${ANALYTICS_TOKEN:-}" python3 -m uvicorn pinpulse_analytics.api:app --host 127.0.0.1 --port 8000 >"$LOG/analytics.log" 2>&1 ) &
pnpm db:migrate
if [ "${1:-}" = "--prod" ]; then pnpm build >"$LOG/build.log" 2>&1; ( pnpm start >"$LOG/web.log" 2>&1 ) & else ( pnpm dev >"$LOG/web.log" 2>&1 ) & fi
( pnpm worker >"$LOG/worker.log" 2>&1 ) &
for url in http://127.0.0.1:4010/__mock/state http://127.0.0.1:8000/healthz http://localhost:3000/api/health; do
  for _ in $(seq 1 120); do curl -fsS -o /dev/null "$url" 2>/dev/null && break; sleep 1; done
done
echo "PinInova (MOCK Pinterest) at http://localhost:3000 — logs in $LOG. Ctrl-C to stop."
if [ -n "${STACK_THEN:-}" ]; then eval "$STACK_THEN"; else wait; fi
