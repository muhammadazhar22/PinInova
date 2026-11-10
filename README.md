# PinInova

Pinterest account health, diagnosis and protection for VAs, agencies, bloggers and shop owners.

> **Status: built and tested against a MOCK Pinterest API only.** No integration is production-ready — see
> [`docs/INTEGRATIONS.md`](docs/INTEGRATIONS.md). Policy questions that Pinterest has not answered are recorded as
> unresolved assumptions, each with a config switch and a fallback, in [`docs/policy/ASSUMPTIONS.md`](docs/policy/ASSUMPTIONS.md).
> The app labels simulated data everywhere it appears (banner, account chips, reports).

```
apps/web                  Next.js 16 app: UI, auth, OAuth, consent, sync, integrity checks, alerts, reports, billing, worker
services/analytics        Python detection/diagnosis engine (FastAPI): changepoints, rate test, breadth, cause classes,
                          CSV parsing, perceptual duplicates, weather index, pre-flight rules, synthetic benchmark
services/pinterest-mock   MOCK Pinterest API v5 + mock websites: 8 scripted scenario accounts, OAuth, scopes, rate limits, faults
docs                      plan, policy assumptions, integration register, research, detector log, reviews
.claude/skills            agent skills (detector-loop)
```

## Run it locally

Requirements: Node 22 + pnpm 9, Python 3.12, Postgres 16, Chrome (for PDFs and browser tests).

```bash
pnpm install
pip install -e "services/analytics[dev]"
docker compose up -d postgres
cp .env.example apps/web/.env.local     # fill BETTER_AUTH_SECRET, TOKEN_KEK_V1 and ANALYTICS_TOKEN (openssl rand -base64 32),
                                        # set INTEGRITY_ALLOW_PRIVATE_HOSTS=true for the local mock websites
scripts/dev-stack.sh                    # mock Pinterest :4010/:4011, analytics :8000, web :3000, worker
```

Open http://localhost:3000, sign up, create a workspace and press **Connect Pinterest account**. You land on a page
titled "MOCK Pinterest — not the real Pinterest"; pick one of the scenario accounts:

| Mock account | What PinInova should find |
|---|---|
| `mock_healthy` | nothing wrong |
| `mock_platform_cliff` | 84% account-wide cut, engagement per view unchanged → platform-side change |
| `mock_domain_block` | one domain's Pins collapse, its robots.txt blocks Pinterestbot → domain issue |
| `mock_new_pins_zero` | new Pins stuck at zero, reused images → duplicate-content issue |
| `mock_quality_drop` | impressions and click rate fall together, broken links → quality down-ranking |
| `mock_viral_fade` | one viral Pin decaying → *not* reported as a cliff |
| `mock_agency_client_1/2` | redirect chains, crawl-delay, slow pages |

## Tests

| Command | What it covers |
|---|---|
| `cd apps/web && pnpm test` | tenancy/RLS, envelope encryption + KEK rotation, Pinterest client (rate limits, 401/429/5xx), purge, SSRF/robots fetcher, BH/FDR, Paddle signatures, PDF rendering — against real Postgres |
| `scripts/test-e2e.sh` | full pipeline for all 8 scenarios: mock OAuth → sync → link checks → diagnosis → alerts → evidence pack → monthly report PDF → client consent link → client revoke → purge |
| `scripts/test-browser.sh` | Playwright in Chrome over the running stack: signup → onboarding → mock OAuth → incident page → evidence pack → PDF → client consent + revoke → disconnect |
| `cd services/pinterest-mock && pnpm test` | mock responses validated against the vendored v5 OpenAPI spec |
| `cd services/analytics && pytest && python -m pinpulse_analytics.benchmark` | detectors, contract, no-lookahead, CSV, duplicates, weather, pre-flight; synthetic benchmark (score ≈ 0.87 vs 0.29 for a naive 50%-drop rule) |

## Guarantees the code enforces

- **Tenant isolation.** The app connects as a non-owner role; every workspace table has a forced RLS policy keyed on a
  transaction-local `app.workspace_id`. Cross-tenant reads exist only as a few audited `SECURITY DEFINER` functions.
- **Consent.** Agency clients connect themselves through a single-use, 14-day consent link that shows exactly what is
  accessed; a versioned consent record is kept; the client gets a private revoke link.
- **Encryption.** OAuth tokens and Slack webhooks are sealed with per-record AES-256-GCM data keys wrapped by a
  versioned KEK; rotation re-wraps keys without touching ciphertext. Tokens are never logged.
- **Deletion.** Disconnect destroys tokens immediately and queues a purge that hard-deletes every row for the
  connection; a nightly job asserts nothing is left; account erasure and data export are self-serve; raw metrics are
  kept 90 days, derived results 395 days (PA-01).
- **Pinterest.** Read-only scopes only (write scopes are refused); per-connection rate gates follow
  `x-ratelimit-*` headers; 401 marks the connection for re-authorization instead of retrying.

## Going live (not done)

Switching `PINTEREST_MODE=live` needs a registered Pinterest app, Standard access and app review — see the blocking
items in `docs/INTEGRATIONS.md`. The production config guard refuses live mode with mock credentials or private-host
fetching enabled.

## Plan and research

- Master plan: `docs/PLAN.md` (Claude doc: https://claude.ai/artifact/RrVoqRUAVvGGayEDXuSLxP)
- Research: `docs/research/`; reviews: `docs/review-*.md`; detector changes: `docs/detector-log.md`
