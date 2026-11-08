#!/usr/bin/env bash
# Starts the mock Pinterest server, mock sites and analytics service, then runs the pipeline e2e suite.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOG="${TMPDIR:-/tmp}/pinpulse-e2e"; mkdir -p "$LOG"
cleanup() { kill $(jobs -p) 2>/dev/null || true; }
trap cleanup EXIT

( cd "$ROOT/services/pinterest-mock" && MOCK_SITE_BASE=http://127.0.0.1:4011 MOCK_RATE_ANALYTICS_PER_MIN=${MOCK_RATE_ANALYTICS_PER_MIN:-6000} pnpm exec tsx src/cli.ts >"$LOG/mock.log" 2>&1 ) &
( cd "$ROOT/services/analytics" && python3 -m uvicorn pinpulse_analytics.api:app --host 127.0.0.1 --port 8000 >"$LOG/analytics.log" 2>&1 ) &

for url in http://127.0.0.1:4010/__mock/state http://127.0.0.1:4011/ http://127.0.0.1:8000/healthz; do
  for _ in $(seq 1 60); do curl -fsS -o /dev/null "$url" 2>/dev/null && break; sleep 0.5; done
  curl -fsS -o /dev/null "$url" || { echo "not ready: $url"; tail -n 50 "$LOG"/*.log; exit 1; }
done

cd "$ROOT/apps/web"
pnpm exec vitest run --config vitest.e2e.config.ts "$@"
