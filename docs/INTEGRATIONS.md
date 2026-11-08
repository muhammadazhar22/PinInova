# Integration readiness register

Nothing here is production-ready. "Implemented" means the code path exists and is tested against a mock or recorded contract; it has **not** been exercised against the live service under an approved app.

| Integration | Status | Tested against | Blocking items before production | Switch |
| --- | --- | --- | --- | --- |
| Pinterest OAuth + API v5 | Implemented; mock-tested only | `services/pinterest-mock` (local server mirroring v5 shapes, rate-limit headers, 401/429/5xx) | Trial app registration; Standard access review (video of this app's OAuth flow); live smoke test; PA-01..PA-09 remain unresolved | `PINTEREST_MODE=mock\|live`, `PINTEREST_API_BASE`, `PINTEREST_OAUTH_BASE` |
| Pinterest Trial tier | Not used by tests | — | Verify PA-09 | — |
| GA4 Data API (Traffic Leak Check) | API client interface + mock; **CSV import of a GA4 export is the supported path** | Mock client, fixture CSV | Google OAuth app verification for `analytics.readonly`; live test | `GA4_MODE=mock\|csv` (no `live` value is accepted yet) |
| Shopify orders (revenue join) | Interface + mock; CSV order-export import | Mock orders, fixture CSV | Shopify Partner app, protected customer data Level 1 request, app review, webhooks registration | `SHOPIFY_MODE=mock\|csv` |
| Paddle billing | Webhook signature verification, entitlements, simulated checkout | Signed fixture payloads | Paddle seller verification (Pakistan), live product/price ids, sandbox end-to-end test | `BILLING_MODE=simulated\|paddle_sandbox` |
| Email (Resend) | Outbox table + console transport; Resend HTTP transport implemented | Outbox assertions | Domain verification, API key | `EMAIL_TRANSPORT=outbox\|resend` |
| Slack incoming webhooks | Implemented; webhook URL encrypted at rest | Local HTTP receiver | Real workspace test | per-workspace setting |
| Link/domain integrity fetcher | Implemented with SSRF guard | Local HTTP fixture server | PA-07 | `INTEGRITY_UA_MODE` |

The in-app page `/app/integrations` renders this table's status from config so users always see which data is simulated.
