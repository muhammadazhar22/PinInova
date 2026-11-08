---
id: SPEC-075
title: Shared-secret auth on the analytics service
status: in-progress
owner: founder
risk: low
spec_version: 1
---

## Why
docs/DEPLOYMENT.md Step 3: the analytics service had no authentication and relied only on network isolation.

## Acceptance criteria
- [x] With `ANALYTICS_TOKEN` set, every analytics route except `/healthz` (including `/docs`, `/openapi.json`) returns
      401 unless `Authorization: Bearer <token>` matches (constant-time compare). `tests/test_auth.py`.
- [x] A token shorter than 32 characters fails closed (500), never open.
- [x] The web client sends the token on every call (`analytics-client.test.ts`).
- [x] The web app refuses `NODE_ENV=production` without a 32+ character `ANALYTICS_TOKEN` (`src/env.test.ts`).
- [x] `infra/docker-compose.prod.yml` refuses to start analytics without the token and passes it nothing else.
- [x] `infra/test-stack.sh`: an unauthenticated call from inside the web container gets 401; the full flow still passes.

## Out of scope
Per-request signing, mTLS. Rotation = set a new value in `.env` and redeploy (web, worker and analytics restart together).

## Data & policy
No data change. The token is a secret: only in the server's `.env` / GitHub secrets, never in logs.

## Rollout
Generate `ANALYTICS_TOKEN` (`openssl rand -base64 32`) before the first staging deploy. Rollback: revert.
