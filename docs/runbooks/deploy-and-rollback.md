# Deploy and roll back (staging)

How releases reach `https://staging.<domain>` (SPEC-073). First-time setup: `docs/runbooks/staging-setup.md`.

## Normal path
1. Merge a PR to `main`. CI (`ci`) runs.
2. When CI is green, `deploy-staging` runs — **only if** the repository variable `STAGING_DEPLOY_ENABLED` is `true`:
   - builds `ghcr.io/<owner>/pinpulse-app:sha-<12 hex>` and `pinpulse-analytics:sha-<…>` (also tagged `staging`);
   - copies `infra/docker-compose.prod.yml`, `infra/deploy.sh` and `infra/caddy/` to `/opt/pinpulse/`;
   - runs `/opt/pinpulse/deploy.sh sha-<…>` over SSH: pull → `migrate` (owner role, `DATABASE_OWNER_URL`) → `up -d` →
     health gate (`/api/health` and `/api/health/worker` from inside the web container, 5 min);
   - checks `/api/health`, `/api/health/worker` and `/privacy` over the public URL.
3. Manual deploy of any ref: Actions → deploy-staging → Run workflow.

`deploy.sh` never changes `PINTEREST_MODE`; it reads it from `/opt/pinpulse/.env`. In `mock` mode it starts the MOCK
Pinterest container and exposes only its consent page on `MOCK_OAUTH_HOST`.

## When a deploy fails
- **Before the restart** (pull or migration fails): nothing was changed; the previous release keeps serving. Fix and
  re-run. A failed migration ran in a transaction per file (`scripts/migrate.ts`), so the database is at the last good file.
- **After the restart** (web or worker not healthy in 5 min): `deploy.sh` restarts the previous tag automatically and
  exits non-zero. Logs of the failed release are printed in the workflow log.

## Manual rollback
```bash
ssh deploy@<server> /opt/pinpulse/deploy.sh --rollback
```
Redeploys the second-to-last tag in `/opt/pinpulse/deploy-history.log` without running migrations. Migrations are
additive only (CLAUDE.md), so older code runs on a newer schema. Or deploy any earlier tag:
`/opt/pinpulse/deploy.sh sha-<…>`.

## Stop deploys
Set `STAGING_DEPLOY_ENABLED` to `false` (Settings → Secrets and variables → Actions → Variables).

## Useful commands on the server
```bash
cd /opt/pinpulse
docker compose -f docker-compose.prod.yml --profile mock ps
docker compose -f docker-compose.prod.yml --profile mock logs -f --tail 100 web worker
cat .deployed-tag; tail deploy-history.log
```
