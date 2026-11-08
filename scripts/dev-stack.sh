#!/usr/bin/env bash
# Runs the whole local stack against MOCK Pinterest: mock API (4010) + mock sites (4011), analytics (8000),
# Next.js (3000) and the job worker. Requires Postgres (docker compose up postgres) and apps/web/.env.local.
# Usage: scripts/dev-stack.sh [--prod]   (--prod runs `next build && next start` instead of `next dev`)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOG="${TMPDIR:-/tmp}/pinpulse-stack"; mkdir -p "$LOG"
trap 'kill $(jobs -p) 2>/dev/null || true' EXIT

( cd "$ROOT/services/pinterest-mock" && MOCK_SITE_BASE=http://127.0.0.1:4011 MOCK_RATE_ANALYTICS_PER_MIN=${MOCK_RATE_ANALYTICS_PER_MIN:-600} pnpm exec tsx src/cli.ts >"$LOG/mock.log" 2>&1 ) &
( cd "$ROOT/services/analytics" && python3 -m uvicorn pinpulse_analytics.api:app --host 127.0.0.1 --port 8000 >"$LOG/analytics.log" 2>&1 ) &

cd "$ROOT/apps/web"
[ -f .env.local ] || { echo "apps/web/.env.local missing — copy .env.example and fill BETTER_AUTH_SECRET/TOKEN_KEK_V1"; exit 1; }
set -a; . ./.env.local; set +a
pnpm db:migrate
if [ "${1:-}" = "--prod" ]; then pnpm build >"$LOG/build.log" 2>&1; ( pnpm start >"$LOG/web.log" 2>&1 ) & else ( pnpm dev >"$LOG/web.log" 2>&1 ) & fi
( pnpm worker >"$LOG/worker.log" 2>&1 ) &
for url in http://127.0.0.1:4010/__mock/state http://127.0.0.1:8000/healthz http://localhost:3000/api/health; do
  for _ in $(seq 1 120); do curl -fsS -o /dev/null "$url" 2>/dev/null && break; sleep 1; done
done
echo "PinPulse (MOCK Pinterest) at http://localhost:3000 — logs in $LOG. Ctrl-C to stop."
if [ -n "${STACK_THEN:-}" ]; then eval "$STACK_THEN"; else wait; fi
