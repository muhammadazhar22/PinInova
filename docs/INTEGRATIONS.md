# Integration readiness register

Nothing here is production-ready. "Implemented" means the code path exists and is tested against a mock or recorded contract; it has **not** been exercised against the live service under an approved app.

| Integration | Status | Tested against | Blocking items before production | Switch |
| --- | --- | --- | --- | --- |
| Pinterest OAuth + API v5 | Implemented; mock-tested only | `services/pinterest-mock` (local server mirroring v5 shapes, rate-limit headers, 401/429/5xx) | Trial app registration; Standard access review (video of this app's OAuth flow); live smoke test; PA-01..PA-09 remain unresolved | `PINTEREST_MODE=mock\|live`, `PINTEREST_API_BASE`, `PINTEREST_OAUTH_BASE` |
| Pinterest Trial tier | Not used by tests | — | Verify PA-09 | — |
| GA4 Data API (Traffic Leak Check) | API client interface + mock; **CSV import of a GA4 export is the supported path** | Mock client, fixture CSV | Google OAuth app verification for `analytics.readonly`; live test | `GA4_MODE=mock\|csv` (no `live` value is accepted yet) |
| Shopify orders (revenue join) | Interface + mock; CSV order-export import | Mock orders, fixture CSV | Shopify Partner app, protected customer data Level 1 request, app review, webhooks registration | `SHOPIFY_MODE=mock\|csv` |
| Paddle billing | Webhook signature verification, signed org id in checkout custom data (SPEC-081), entitlements, overlay checkout (Paddle.js v2) with price IDs from settings, simulated checkout | Signed fixture payloads; checkout config unit tests | Paddle seller verification (Pakistan), sandbox end-to-end test with real price IDs, live product/price ids | `BILLING_MODE=simulated\|paddle_sandbox\|paddle_live` |
| Email (Resend) | Outbox table + console transport; Resend HTTP transport implemented | Outbox assertions | Domain verification, API key | `EMAIL_TRANSPORT=outbox\|resend` |
| Slack incoming webhooks | Implemented; webhook URL encrypted at rest | Local HTTP receiver | Real workspace test | per-workspace setting |
| Sentry (errors, OTel-based tracing) | Implemented; scrubbed events | Unit tests + local fake ingest | DSN from a Sentry project; first staging event checked by hand | `SENTRY_DSN` (unset = off), `SENTRY_TRACES_SAMPLE_RATE` |
| Link/domain integrity fetcher | Implemented with SSRF guard | Local HTTP fixture server | PA-07 | `INTEGRITY_UA_MODE` |

The in-app page `/app/integrations` renders this table's status from config so users always see which data is simulated.

## Contract details the mock had to guess

These shapes are not settled by Pinterest's OpenAPI spec. The mock picks one reading (marked `[MA]` in
`services/pinterest-mock/README.md`) and the client is written to tolerate the alternatives. Each must be confirmed
in the first live smoke test.

| Detail | Mock behaviour | Client tolerance |
|---|---|---|
| Analytics split keys | `all` for NO_SPLIT; filter enum values otherwise (e.g. `CLAIMED`/`OTHER`) | keys treated as an open `Record`, lower-cased |
| Timestamps | RFC 3339 with `Z` | parses with or without offset |
| `user_account/websites` | `website` includes scheme; status `verified`/`unverified` | domain extracted from either; only verified/claimed statuses count |
| robots.txt for mock sites | `/<slug>/robots.txt` (all mock sites share one host) | mock-mode domain key = host + first path segment; live uses `/robots.txt` |
| Native analytics CSV export columns | n/a (analytics service aliases) | aliases documented in `services/analytics/README.md`; not checked against a real export |

## Operational limits

- Pinterest rate gates are per process. Sync jobs are singleton per connection (pg-boss `singletonKey`), so a
  connection's gate is owned by one worker at a time; any new job type that calls Pinterest for a connection must
  run inside the sync job or move the gate to Postgres/Redis first.
- `TRUST_PROXY=true` only behind a proxy that appends the client IP to `X-Forwarded-For`.
