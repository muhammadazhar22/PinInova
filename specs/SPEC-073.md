---
id: SPEC-073
title: CI/CD — green CI and gated staging deploy
status: in-progress
owner: founder
risk: medium
spec_version: 1
---

## Why
docs/DEPLOYMENT.md Steps 1 and 3: CI must be green, and a merge to `main` should build images, migrate with the owner
role and restart staging over SSH, without anyone deploying by hand.

## Acceptance criteria
- [x] CI green on PRs (pnpm setup, baseline-guard checkout depth, analytics `[api]` extra in e2e).
- [x] `deploy-staging` runs only after `ci` succeeds on `main` (or by hand) **and** `vars.STAGING_DEPLOY_ENABLED == 'true'`.
- [x] Images pushed to GHCR tagged `sha-<12>` + `staging`; the server pulls with the job's short-lived token.
- [x] SSH uses a pinned host key (`STAGING_SSH_KNOWN_HOSTS`), `StrictHostKeyChecking=yes`.
- [x] `infra/deploy.sh`: migrate with `DATABASE_OWNER_URL`, restart, health gate on web + worker, automatic rollback
      when the new release is unhealthy, `--rollback` for manual use; never touches `PINTEREST_MODE`.
- [x] `scripts/migrate.ts` works with a Neon-style owner (NOSUPERUSER, BYPASSRLS): creates `pinpulse_app` itself, grants
      itself SET on it, applies the app password from `DATABASE_URL`, and **refuses to finish if `pinpulse_app` can
      bypass RLS** (a role created in the Neon console would). CI job `web-neon-owner` runs the whole suite that way.
- [x] Production refuses the default `pinpulse_app` password (web guard and migrate).
- [x] `infra/test-stack.sh` deploys through `deploy.sh`, then proves a missing image changes nothing and an unhealthy
      release is rolled back.

## Out of scope
Production environment (Step 6), tagged releases `v2027.01.x`, blue/green.

## Rollout
Owner creates the server, Neon, secrets and variables (`docs/runbooks/staging-setup.md`), then sets
`STAGING_DEPLOY_ENABLED=true`. Rollback: `deploy.sh --rollback` (docs/runbooks/deploy-and-rollback.md).
