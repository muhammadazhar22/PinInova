#!/usr/bin/env bash
# Builds the production images and runs infra/docker-compose.prod.yml locally behind Caddy (APP_HOST=localhost,
# local CA), with MOCK Pinterest and a throwaway Postgres instead of Neon. Then checks health, the public surface
# (internal endpoints must 404) and, with --browser, runs the Playwright browser e2e against https://localhost.
# Usage: infra/test-stack.sh [--browser] [--no-build]     Needs Docker with compose v2 and ports 80/443 free.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BROWSER=false; BUILD=true
for a in "$@"; do case "$a" in --browser) BROWSER=true ;; --no-build) BUILD=false ;; *) echo "unknown arg $a"; exit 2 ;; esac; done

TAG=stacktest
if $BUILD; then
  docker build ${APP_BUILD_ARGS:-} -f "$ROOT/infra/app.Dockerfile" -t "pinpulse-app:$TAG" "$ROOT"
  docker build ${ANALYTICS_BUILD_ARGS:-} -t "pinpulse-analytics:$TAG" "$ROOT/services/analytics"
fi

WORK="$(mktemp -d)"
cp -r "$ROOT/infra/docker-compose.prod.yml" "$ROOT/infra/docker-compose.test.yml" "$ROOT/infra/caddy" "$WORK/"
mkdir -p "$WORK/caddy/enabled" && cp "$WORK/caddy/mock-oauth.caddy" "$WORK/caddy/enabled/"
# Test-only values. Real secrets are generated per environment (docs/runbooks/staging-setup.md).
cat > "$WORK/.env" <<ENV
APP_HOST=localhost
MOCK_OAUTH_HOST=mock.localhost
ACME_EMAIL=ops@example.com
APP_IMAGE=pinpulse-app
ANALYTICS_IMAGE=pinpulse-analytics
IMAGE_TAG=$TAG
APP_URL=https://localhost
DATABASE_URL=postgres://pinpulse_app:pinpulse_app@postgres:5432/pinpulse
DATABASE_OWNER_URL=postgres://postgres:dev@postgres:5432/pinpulse
BETTER_AUTH_SECRET=$(openssl rand -base64 32)
TOKEN_KEK_V1=$(openssl rand -base64 32)
TOKEN_KEK_CURRENT=v1
ANALYTICS_URL=http://analytics:8000
PINTEREST_MODE=mock
PINTEREST_API_BASE=http://pinterest-mock:4010/v5
PINTEREST_OAUTH_BASE=https://mock.localhost/oauth/
INTEGRITY_ALLOW_PRIVATE_HOSTS=true
BILLING_MODE=simulated
EMAIL_TRANSPORT=outbox
ENV
DC=(docker compose --project-directory "$WORK" -p pinpulse-stacktest -f "$WORK/docker-compose.prod.yml" -f "$WORK/docker-compose.test.yml" --profile mock)
cleanup() { [ "${KEEP:-}" = 1 ] || { "${DC[@]}" logs --no-color > "$WORK/stack.log" 2>&1 || true; "${DC[@]}" down -v --remove-orphans >/dev/null 2>&1 || true; echo "logs: $WORK/stack.log"; }; }
trap cleanup EXIT

"${DC[@]}" config -q
"${DC[@]}" run --rm migrate
"${DC[@]}" up -d --wait --wait-timeout 180

curl_() { curl -sk --resolve localhost:443:127.0.0.1 --resolve mock.localhost:443:127.0.0.1 "$@"; }
for _ in $(seq 1 60); do curl_ -fo /dev/null https://localhost/api/health && break; sleep 2; done
health="$(curl_ https://localhost/api/health)"; echo "health: $health"
echo "$health" | grep -q '"db":true' && echo "$health" | grep -q '"analytics":true' || { echo "FAIL health"; exit 1; }

expect() { local want="$1" url="$2" got; got="$(curl_ -o /dev/null -w '%{http_code}' "$url")"; [ "$got" = "$want" ] || { echo "FAIL $url -> $got (want $want)"; exit 1; }; echo "ok   $url -> $got"; }
expect 200 https://localhost/
expect 404 https://localhost/__mock/state
expect 200 "https://mock.localhost/oauth/?client_id=mock-client-id&redirect_uri=https://localhost/api/pinterest/callback&response_type=code&scope=user_accounts:read&state=x"
expect 404 https://mock.localhost/__mock/state
expect 404 https://mock.localhost/v5/user_account
curl_ -sI https://localhost/ | grep -qi '^strict-transport-security' && echo "ok   HSTS"

if $BROWSER; then
  ( cd "$ROOT/apps/web" && APP_URL=https://localhost E2E_IGNORE_HTTPS_ERRORS=true pnpm exec playwright test )
fi
echo "stack test passed"
