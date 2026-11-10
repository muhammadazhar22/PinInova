# PinInova — agent operating rules

PinInova is a Pinterest account health, diagnosis and protection SaaS. One founder, many agents.
Formerly named PinPulse: user-facing text says PinInova, but internal identifiers keep the old name on purpose
(`pinpulse_app` DB role, `pinpulse_analytics` package, `pinpulse-app` images, staging resource names); research notes,
reviews and merged migrations are historical and still say PinPulse. Do not rename those without asking.
Start with `README.md`, `docs/DEPLOYMENT.md` (current next steps) and `docs/PLAN.md`. Spec IDs (e.g. `SPEC-012`) refer to PLAN.md; `specs/` holds the template.

## Repo map
- `apps/web` — Next.js 16 (App Router, TypeScript strict). UI, auth (Better Auth), OAuth, sync, checks, alerts, reports, billing; worker in `src/worker` (pg-boss). Modules in `src/modules/<name>`. SQL migrations in `apps/web/db/migrations` (plain SQL, applied by `pnpm db:migrate`; RLS on every workspace table).
- `services/analytics` — Python 3.12 package `pinpulse_analytics`. Pure detection math + FastAPI wrapper. **No network calls to Pinterest from here.**
- `services/pinterest-mock` — mock Pinterest API v5 + mock websites (8 scenario accounts). Used by tests and local dev.
- `packages/shared` — placeholder for shared schemas (the web↔analytics contract is `apps/web/src/modules/health/analytics-client.ts` + `services/analytics/openapi.json`).
- `infra` — empty; Dockerfiles, compose and runbooks for deployment go here (docs/DEPLOYMENT.md Step 3).
- `docs` — PLAN, DEPLOYMENT, INTEGRATIONS, policy/ASSUMPTIONS, reviews, ADRs, detector log.

## Non-negotiables (policy)
1. Never scrape Pinterest. Only API v5 with the user's OAuth token. No logged-out fetches of pinterest.com.
2. Raw API responses are cached at most 90 days and only for the user who authorized them. Derived aggregates must be per-user. Never join one user's Pinterest data with another's (the weather index is a separate, authorization-gated module; see `specs/SPEC-030-weather.md`).
3. Disconnect = delete. `pinterest_disconnect` must purge raw + derived data within 24h and write an audit row.
4. Never edit a user's Pins or boards. Read scopes only.
5. No "recovery guarantee" copy anywhere in UI or email. Use "likely cause", "evidence", "confidence".

## Engineering rules
- TypeScript strict; in `apps/web`: `pnpm typecheck && pnpm test` (needs Postgres 16 with owner `postgres:dev` on localhost:5432), `scripts/test-e2e.sh` and `scripts/test-browser.sh` before any PR that touches the pipeline or UI. Python: `ruff`, `mypy` on `pinpulse_analytics` (strict mode is a v1 gate task), `pytest`.
- Detector changes must keep `python -m pinpulse_analytics.benchmark` score ≥ `benchmark_baseline.json` − 0.01. Improvements are followed by a separate PR that updates the baseline; CI rejects baseline + detector changes in one PR. The score must also stay above the absolute floor 0.6.
- All Pinterest API calls go through `apps/web/src/modules/pinterest/client.ts` (rate gates, retries, 401→re-auth). Contract tests: `services/pinterest-mock` validates against the vendored spec in `fixtures/pinterest/`.
- Every transaction that writes rows for a connection starts with `lockConnection()` (`src/modules/pinterest/guard.ts`).
- Migrations: add a new numbered `.sql` file; never edit a migration after merge; additive only (no drop/rename without asking).
- Secrets: never in code, fixtures or logs.
- Every PR: spec ID in title, "Risk" and "Rollback" sections in body, screenshots for UI.

## Loop protocol (what an agent does on a task)
1. Read the spec; write/refresh `specs/<id>.md` acceptance criteria as checkboxes if missing.
2. Write failing tests for the criteria first.
3. Implement the smallest change that passes; run the full gate locally.
4. Self-review against the non-negotiables and `docs/review-2026-11-08-security.md`, fix, then open a PR.
5. Policy assumptions: unresolved Pinterest policy questions live in `docs/policy/ASSUMPTIONS.md` (PA-01..PA-10). Build against them; do not pause work to request Pinterest's permission; never mark one approved; cite the ID in code (`// policy: PA-01`) and read its config switch. Integration status lives in `docs/INTEGRATIONS.md`; never describe an integration as production-ready unless that file says live-verified.
6. Never bypass OAuth, Pinterest access tiers, rate limits or app review. Where API access is unavailable, use the mock Pinterest server (`services/pinterest-mock`) and label it as mock in UI and logs.
7. Stop and ask a human when: a spec contradicts a non-negotiable; a change touches billing, OAuth scopes, data deletion, or Pinterest policy text; a migration drops or renames a column; CI is red for a reason outside the task.

## Commands
- `scripts/dev-stack.sh` — whole stack against mock Pinterest (needs `apps/web/.env.local`, see `.env.example`).
- `pnpm bench` — analytics benchmark. `cd apps/web && pnpm test` — unit/RLS tests. `scripts/test-e2e.sh`, `scripts/test-browser.sh`.
