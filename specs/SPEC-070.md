---
id: SPEC-070
title: Container images and production compose (Hetzner VPS + Caddy)
status: in-progress
owner: founder
risk: medium
spec_version: 1
---

## Why
docs/DEPLOYMENT.md Step 3: staging runs web, worker, analytics and Chrome on one VPS with Docker Compose and Caddy,
Postgres on Neon. Report PDFs render inside the web process with Chromium; analytics has no public surface.

## Acceptance criteria
- [x] `infra/app.Dockerfile` builds one image used for web, worker, migrations and the MOCK Pinterest server; it contains
      the Chromium build matching `playwright-core` and renders a PDF as a non-root user.
- [x] `services/analytics/Dockerfile` builds the analytics image (non-root).
- [x] `infra/docker-compose.prod.yml`: Caddy (80/443) → web; analytics only on an `internal: true` network; worker has
      egress; migrations are a one-off `migrate` service using `DATABASE_OWNER_URL`; MOCK Pinterest only under the
      `mock` profile.
- [x] Caddy serves HSTS, hides `/__mock*` on the app host, and in mock mode exposes only the mock `/oauth` pages on
      `MOCK_OAUTH_HOST` (`/v5` and `/__mock` return 404).
- [x] Redirects and cookie `Secure` flags are derived from `APP_URL`, not the bind address behind the proxy
      (`src/lib/urls.test.ts`).
- [x] `infra/test-stack.sh --browser` passes: health green (db + analytics), public-surface checks, browser e2e against
      `https://localhost` (CI job `stack`).

## Out of scope
Deploy automation (SPEC-073), backups (SPEC-074), analytics auth (SPEC-075), observability (SPEC-072).

## Data & policy
No change to data handling. MOCK Pinterest stays labelled and is only started with `PINTEREST_MODE=mock`.

## Test plan
`cd apps/web && pnpm typecheck && pnpm test`; `scripts/test-e2e.sh`; `scripts/test-browser.sh`; `infra/test-stack.sh --browser`.

## Rollout
Images are built but not deployed by this change. Rollback: revert.
