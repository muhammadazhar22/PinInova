---
id: SPEC-072
title: Error reporting, tracing and worker heartbeat
status: in-progress
owner: founder
risk: medium
spec_version: 1
---

## Why
docs/DEPLOYMENT.md Step 3: Sentry and OpenTelemetry, and a worker heartbeat on the health endpoint, so the founder is
paged on errors and on a dead worker (nightly sync, purge and retention all run in the worker).

## Acceptance criteria
- [x] `SENTRY_DSN` unset ⇒ nothing is sent (local dev, tests, CI).
- [x] Web server (`src/instrumentation.ts`, `onRequestError`) and worker (job failures, purge-assertion leftovers as
      `fatal`) report to Sentry.
- [x] Every event is scrubbed before it leaves the process (`src/lib/observability/scrub.ts`): capability tokens in
      `/consent|/r|/invite|/revoke` paths, query strings (OAuth `code`), cookies, non-allow-listed headers, request
      bodies, user e-mail/IP, `extra`, non-standard contexts; secrets in messages via `redact()`; console breadcrumbs
      dropped; `sendDefaultPii: false`. Tests: `scrub.test.ts`, `sentry-options.test.ts`; verified against a local fake
      ingest (message arrives as `Bearer [redacted]`).
- [x] Events carry `component` and `pinterest_mode` tags (mock data stays labelled).
- [x] Tracing: Sentry's SDK is OpenTelemetry-based; `SENTRY_TRACES_SAMPLE_RATE` (default 0) exports OTel spans. No
      separate OTLP collector (no extra cost).
- [x] Worker heartbeat every 30 s: Postgres (`0008_worker_heartbeat.sql`, RLS on, app role only via two
      `SECURITY DEFINER` functions) + a local file for the container healthcheck.
- [x] `GET /api/health/worker` → 200 when the last beat is ≤ `WORKER_STALE_SECONDS` (180), else 503.
      `GET /api/health` reports `worker` and `worker_last_beat_age_s` without changing its own status code.
- [x] `infra/test-stack.sh` checks `/api/health/worker` = 200 and the worker container is healthy.

## Out of scope
Browser-side Sentry (would need a build-time public DSN and raises PII questions), source-map upload, session replay.

## Data & policy
No Pinterest data, tokens or e-mail addresses are sent to Sentry. The heartbeat table holds no tenant data.

## Rollout
Set `SENTRY_DSN`, `SENTRY_ENVIRONMENT=staging`; uptime monitor on `/api/health` and `/api/health/worker`.
Rollback: unset `SENTRY_DSN` (no code change needed) or revert; the migration is additive.
