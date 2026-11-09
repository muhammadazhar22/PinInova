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
cp -r "$ROOT/infra/docker-compose.prod.yml" "$ROOT/infra/docker-compose.test.yml" "$ROOT/infra/caddy" "$ROOT/infra/deploy.sh" "$WORK/"
# Test-only values. Real secrets are generated per environment (docs/runbooks/staging-setup.md).
cat > "$WORK/.env" <<ENV
APP_HOST=localhost
MOCK_OAUTH_HOST=mock.localhost
ACME_EMAIL=ops@example.com
APP_IMAGE=pinpulse-app
ANALYTICS_IMAGE=pinpulse-analytics
APP_URL=https://localhost
DATABASE_URL=postgres://pinpulse_app:$(openssl rand -hex 24)@postgres:5432/pinpulse
DATABASE_OWNER_URL=postgres://postgres:dev@postgres:5432/pinpulse
BETTER_AUTH_SECRET=$(openssl rand -base64 32)
TOKEN_KEK_V1=$(openssl rand -base64 32)
TOKEN_KEK_CURRENT=v1
ANALYTICS_URL=http://analytics:8000
ANALYTICS_TOKEN=$(openssl rand -base64 32)
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

export IMAGE_TAG=$TAG COMPOSE_PROJECT_NAME=pinpulse-stacktest DEPLOY_SKIP_PULL=1 DEPLOY_EXTRA_COMPOSE=docker-compose.test.yml
"${DC[@]}" config -q
# Deploy exactly as the server does: migrate with the owner role, start, gate on web + worker health (SPEC-073).
"$WORK/deploy.sh" "$TAG"

curl_() { curl -sk --resolve localhost:443:127.0.0.1 --resolve mock.localhost:443:127.0.0.1 "$@"; }
for _ in $(seq 1 90); do curl_ -fo /dev/null https://localhost/api/health && break; sleep 2; done
health="$(curl_ https://localhost/api/health || true)"; echo "health: $health"
echo "$health" | grep -q '"db":true' && echo "$health" | grep -q '"analytics":true' || { echo "FAIL health"; exit 1; }

for _ in $(seq 1 45); do curl_ -fo /dev/null https://localhost/api/health/worker && break; sleep 2; done
expect() { local want="$1" url="$2" got; got="$(curl_ -o /dev/null -w '%{http_code}' "$url")"; [ "$got" = "$want" ] || { echo "FAIL $url -> $got (want $want)"; exit 1; }; echo "ok   $url -> $got"; }
expect 200 https://localhost/
expect 404 https://localhost/__mock/state
expect 200 https://localhost/api/health/worker
expect 200 "https://mock.localhost/oauth/?client_id=mock-client-id&redirect_uri=https://localhost/api/pinterest/callback&response_type=code&scope=user_accounts:read&state=x"
expect 404 https://mock.localhost/__mock/state
expect 404 https://mock.localhost/v5/user_account
# The analytics service is unreachable from outside and rejects callers without the shared secret (SPEC-075).
code="$("${DC[@]}" exec -T web node -e "fetch('http://analytics:8000/v1/weather',{method:'POST',headers:{'content-type':'application/json'},body:'{\"windows\":[]}'}).then(r=>console.log(r.status))")"
[ "$code" = 401 ] || { echo "FAIL analytics without token -> $code"; exit 1; }; echo "ok   analytics without token -> 401"
curl_ -sI https://localhost/ | grep -qi '^strict-transport-security' && echo "ok   HSTS"

if $BROWSER; then
  ( cd "$ROOT/apps/web" && APP_URL=https://localhost E2E_IGNORE_HTTPS_ERRORS=true pnpm exec playwright test )
fi
# A release whose image is missing fails before anything is touched; the healthy release keeps serving.
if "$WORK/deploy.sh" does-not-exist >"$WORK/bad-deploy.log" 2>&1; then echo "FAIL missing-image deploy reported success"; exit 1; fi
[ "$(cat "$WORK/.deployed-tag")" = "$TAG" ] && curl_ -fo /dev/null https://localhost/api/health && echo "ok   missing image: deploy failed, $TAG still serving"
# A release that starts but never gets healthy is rolled back to the previous tag.
printf 'FROM pinpulse-app:%s\nCMD ["node","-e","setInterval(()=>{},1e9)"]\n' "$TAG" | docker build -q -t pinpulse-app:unhealthy - >/dev/null
docker tag "pinpulse-analytics:$TAG" pinpulse-analytics:unhealthy
if DEPLOY_HEALTH_TRIES=4 "$WORK/deploy.sh" unhealthy >"$WORK/bad-deploy.log" 2>&1; then echo "FAIL unhealthy deploy reported success"; exit 1; fi
grep -q "rolling back to $TAG" "$WORK/bad-deploy.log" || { echo "FAIL no rollback"; tail -20 "$WORK/bad-deploy.log"; exit 1; }
for _ in $(seq 1 60); do curl_ -fo /dev/null https://localhost/api/health && break; sleep 2; done
[ "$(cat "$WORK/.deployed-tag")" = "$TAG" ] && curl_ -fo /dev/null https://localhost/api/health && echo "ok   unhealthy release rolled back to $TAG"
docker image rm pinpulse-app:unhealthy pinpulse-analytics:unhealthy >/dev/null 2>&1 || true
echo "stack test passed"
