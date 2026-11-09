---
id: SPEC-076
title: Live smoke test of the guessed Pinterest contract details
status: in-progress
owner: founder
risk: low
spec_version: 1
---

## Why
docs/INTEGRATIONS.md lists five contract details the mock had to guess. docs/DEPLOYMENT.md Step 4.3 runs a smoke test
against the real API after the first real connection, before recording the Standard-access demo.

## Acceptance criteria
- [x] `apps/web/scripts/smoke-live.ts --workspace --connection [--csv] [--json]`; exit 1 on any failed check.
- [x] Read-only GETs through `clientFor()` (rate gates, 401 → re-auth); robots.txt through the SSRF-guarded fetcher,
      claimed sites only, max 3 (PA-07).
- [x] Checks: analytics split keys + date format + metric names; timestamps; websites scheme/status; robots.txt path;
      CSV export columns (optional); plus PA-08 provisional days (informational).
- [x] Output holds shapes and counts only; nothing is stored. Mock mode is labelled "MOCK — NOT a live check".
- [x] Unit tests for each check with mock and alternative shapes; e2e run against MOCK Pinterest passes all checks.
- [x] Runbook `docs/runbooks/live-smoke-test.md`.

## Out of scope
Switching to live mode (owner, Step 4.1); running it against Pinterest (needs the registered app).

## Data & policy
Uses only the connected account's own data under its OAuth grant (non-negotiables 1, 4). PA-08 observations are recorded
as observations, not as resolution.
