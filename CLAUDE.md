# PinPulse — agent operating rules

PinPulse is a Pinterest account health, diagnosis and protection SaaS. One founder, many agents.
Read `specs/README.md` before any task. Every change traces to a spec ID (e.g. `SPEC-012`).

## Repo map
- `apps/web` — Next.js (App Router, TypeScript). UI, auth, billing, OAuth, job enqueueing. Modular monolith: `src/modules/<name>` with `index.ts` as the only public surface.
- `services/analytics` — Python 3.11 package `pinpulse_analytics`. Pure detection math + FastAPI wrapper. **No network calls to Pinterest from here.**
- `packages/shared` — zod schemas + generated types shared by web and analytics (JSON Schema export).
- `infra` — Terraform/SST + Dockerfiles + runbooks.
- `specs` — one markdown file per feature spec; status in frontmatter.
- `docs` — ADRs (`docs/adr/NNNN-*.md`), threat model, Pinterest policy notes with dated copies.

## Non-negotiables (policy)
1. Never scrape Pinterest. Only API v5 with the user's OAuth token. No logged-out fetches of pinterest.com.
2. Raw API responses are cached at most 90 days and only for the user who authorized them. Derived aggregates must be per-user. Never join one user's Pinterest data with another's (the weather index is a separate, authorization-gated module; see `specs/SPEC-030-weather.md`).
3. Disconnect = delete. `pinterest_disconnect` must purge raw + derived data within 24h and write an audit row.
4. Never edit a user's Pins or boards. Read scopes only.
5. No "recovery guarantee" copy anywhere in UI or email. Use "likely cause", "evidence", "confidence".

## Engineering rules
- TypeScript strict; `pnpm lint typecheck test` must pass before any PR. Python: `ruff`, `mypy --strict` on `pinpulse_analytics`, `pytest`.
- Detector changes must keep `python -m pinpulse_analytics.benchmark` score ≥ `benchmark_baseline.json` − 0.01. Improvements update the baseline in the same PR with the new number in the PR body.
- All Pinterest API calls go through `apps/web/src/modules/pinterest/client.ts` (rate limiter, retries, fixture recording). Contract tests run against recorded fixtures in `apps/web/test/fixtures/pinterest/`.
- Migrations: `drizzle-kit generate`; never edit a migration after merge.
- Secrets: never in code or fixtures; fixtures are scrubbed by `scripts/scrub-fixtures.ts`.
- Every PR: spec ID in title, "Risk" and "Rollback" sections in body, screenshots for UI.

## Loop protocol (what an agent does on a task)
1. Read the spec; write/refresh `specs/<id>.md` acceptance criteria as checkboxes if missing.
2. Write failing tests for the criteria first.
3. Implement the smallest change that passes; run the full gate locally.
4. Self-review with `/review` checklist (`.claude/skills/review/SKILL.md`), fix, then open PR.
5. Stop and ask a human when: a spec contradicts a non-negotiable; a change touches billing, OAuth scopes, data deletion, or Pinterest policy text; a migration drops or renames a column; CI is red for a reason outside the task.

## Commands
- `pnpm dev` (web + analytics via docker compose), `pnpm test`, `pnpm e2e`, `pnpm bench` (runs the analytics benchmark).
- `pnpm spec new "<title>"` scaffolds a spec with the template.
