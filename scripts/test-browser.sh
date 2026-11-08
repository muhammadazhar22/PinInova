#!/usr/bin/env bash
# Browser e2e (Playwright) against the full stack with MOCK Pinterest.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STACK_THEN="cd '$ROOT/apps/web' && pnpm exec playwright test" exec "$ROOT/scripts/dev-stack.sh" --prod
