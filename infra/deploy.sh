#!/usr/bin/env bash
# Server-side deploy (SPEC-073). Lives in /opt/pinpulse next to docker-compose.prod.yml, caddy/ and .env (mode 600).
# Called by .github/workflows/deploy-staging.yml over SSH, or by hand:
#   ./deploy.sh <image-tag>          pull, migrate (owner role), restart, health-check; on failure roll back
#   ./deploy.sh --rollback           redeploy the previous tag (no migration; migrations are additive only)
set -euo pipefail
cd "$(dirname "$0")"
[ -f .env ] || { echo "missing /opt/pinpulse/.env (see docs/runbooks/staging-setup.md)"; exit 1; }
getenv() { grep -E "^$1=" .env | tail -n 1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//'; }

if [ "${1:-}" = "--rollback" ]; then
  TAG="$(tail -n 2 deploy-history.log 2>/dev/null | head -n 1 | cut -d' ' -f2)"; MIGRATE=false
  [ -n "$TAG" ] || { echo "no previous deploy recorded"; exit 1; }
else
  TAG="${1:?usage: deploy.sh <image-tag> | --rollback}"; MIGRATE=true
fi
PREV="$(cat .deployed-tag 2>/dev/null || true)"

# MOCK Pinterest runs (and its consent page is exposed) only while PINTEREST_MODE=mock.
mkdir -p caddy/enabled && rm -f caddy/enabled/*.caddy
PROFILES=()
if [ "$(getenv PINTEREST_MODE)" = "mock" ]; then cp caddy/mock-oauth.caddy caddy/enabled/; PROFILES=(--profile mock); fi

export IMAGE_TAG="$TAG"
# DEPLOY_EXTRA_COMPOSE / DEPLOY_SKIP_PULL exist only for infra/test-stack.sh (local images, throwaway Postgres).
DC=(docker compose -f docker-compose.prod.yml ${DEPLOY_EXTRA_COMPOSE:+-f "$DEPLOY_EXTRA_COMPOSE"} "${PROFILES[@]}")
log() { echo "[$(date -u +%FT%TZ)] $*"; }

healthy() {
  for _ in $(seq 1 "${DEPLOY_HEALTH_TRIES:-60}"); do
    if "${DC[@]}" exec -T web node -e "Promise.all(['/api/health','/api/health/worker'].map(p=>fetch('http://127.0.0.1:3000'+p).then(r=>{if(!r.ok)throw p}))).then(()=>process.exit(0),()=>process.exit(1))" 2>/dev/null; then return 0; fi
    sleep 5
  done
  return 1
}

log "deploying $TAG (previous: ${PREV:-none})"
[ "${DEPLOY_SKIP_PULL:-}" = 1 ] || "${DC[@]}" pull --quiet
if $MIGRATE; then "${DC[@]}" run --rm migrate; fi
if "${DC[@]}" up -d --remove-orphans && healthy; then
  echo "$TAG" > .deployed-tag
  echo "$(date -u +%FT%TZ) $TAG" >> deploy-history.log
  docker image prune -f >/dev/null
  log "deployed $TAG: web and worker healthy"
else
  log "health check failed for $TAG"
  "${DC[@]}" ps
  "${DC[@]}" logs --tail 80 web worker || true
  if [ -n "$PREV" ] && [ "$PREV" != "$TAG" ]; then
    log "rolling back to $PREV"
    IMAGE_TAG="$PREV" "${DC[@]}" up -d --remove-orphans
  fi
  exit 1
fi
