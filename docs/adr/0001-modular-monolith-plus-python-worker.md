# ADR-0001: Modular monolith (Next.js/TS) + one Python analytics service

Status: accepted · Date: 2026-11-07

## Context
One founder; agents do most coding. The product is 80% CRUD/integration/UI and 20% statistics.
Statistical libraries (numpy/scipy, ruptures, PyMC) are mature in Python; the web ecosystem is TypeScript.

## Decision
- `apps/web`: Next.js App Router monolith with internal modules (`src/modules/*`), Drizzle + Postgres, pg-boss job queue (Postgres-backed; no Redis dependency at v1).
- `services/analytics`: stateless FastAPI service exposing `/v1/diagnose`; pure functions, no DB, no Pinterest calls. Called by the web worker per user with that user's series only.
- Shared contracts via zod → JSON Schema in `packages/shared`.

## Consequences
+ One deploy unit for the product; the stats service can be scaled or rewritten independently.
+ The analytics service never sees tokens or cross-user data, which simplifies the Pinterest compliance story.
− Two languages; mitigated by contract tests and generated clients.
