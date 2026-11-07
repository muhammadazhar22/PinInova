# PinPulse — Technical Architecture, Deployment, Compliance, and Agent-Driven Development Report

Date: 7 Nov 2026. Scope: one founder in Pakistan, Claude Code-heavy workflow, Pinterest API v5 analytics SaaS with agency mode. Everything marked **(est.)** is my estimate; everything else links to a source I actually fetched. One source I could not read: Pinterest's *Developer & API Terms* page (`policy.pinterest.com/en/developer-terms`) returned a client error twice; the retention analysis below relies on the *Developer Guidelines* page, which did load.

---

## 0. Executive summary (the firm recommendations)

| Area | Recommendation | One-line reason |
|---|---|---|
| Web/app | **Next.js 16.4 App Router + TypeScript + shadcn/ui + Tailwind v4** | Cache Components are now the recommended default for new apps and ship with `next upgrade --agent` and agent Skills; largest hiring/agent-knowledge pool. |
| Charts | **ECharts (via `echarts-for-react`) for annotated time series; Recharts only for trivial sparklines** | ECharts has first-class `markLine/markArea/markPoint` annotations, canvas rendering for 90-day × many-pin series, and SVG mode for PDF export. |
| Backend shape | **Modular monolith in Next.js (Route Handlers + Server Actions) + one Python worker (FastAPI/uv) for statistics + one Node worker process for sync/alerts** | Keep product code in one TS codebase; keep stats in Python where `ruptures`/`statsmodels` live. |
| Stats engine | **Python** (`ruptures` PELT/Binseg + `statsmodels`), not a TS port | Mature, tested, BSD-licensed; the detector is the product's moat and must be property-tested, not re-implemented. |
| Database | **Postgres on Neon (Launch) at v1 → self-hosted/Hetzner or RDS later; plain daily-range partitioning via `pg_partman`-style scripts; RLS for agency tenants; no TimescaleDB, no ClickHouse at v1** | Supabase has deprecated TimescaleDB in favour of pg_partman; Neon has branching for agent preview envs; row volumes at 10k accounts are tens of GB, well within partitioned Postgres. |
| Jobs | **pg-boss** (Postgres-backed) for v1; keep an adapter seam so Trigger.dev/Inngest can be swapped if observability pain grows | No Redis, no per-step billing on per-pin API calls, cron + retries + DLQ + rate-limit storage policies built in. |
| Auth | **Better Auth** with `organization` plugin (agency mode) and `generic-oauth` plugin for Pinterest | Lucia is deprecated and points to Better Auth; Auth.js has no built-in orgs/2FA. |
| Token storage | AES-256-GCM envelope encryption in app code, data keys wrapped by a KMS/KEK; tokens never in logs; rotate KEK yearly | Pinterest access tokens live 30 days, refresh tokens 60 days (continuous refresh), so the DB holds long-lived secrets. |
| Email / Slack | **Resend** (free 3k/mo → $20 Pro) ; Slack incoming webhooks | Cheapest path to real users; Postmark costs rise faster above 50k. |
| PDF | **Playwright/Chromium on the worker VPS** (not serverless), rendering the same React report components; `@react-pdf/renderer` as the serverless fallback | Charts must match the dashboard; Chromium needs 400–600 MB and fails on serverless size limits. |
| Observability | **Sentry (Developer free → Team $29)** + **OpenTelemetry → Grafana Cloud Free (50 GB logs/traces)** + **Better Stack Uptime free (10 monitors, 1 status page)** | All free at v1, OTel-portable later. |
| Flags/analytics/support | **PostHog** (1M events, 1M flag requests free) ; **Crisp Free (2 seats)** → Plain later | Zero cost until real scale. |
| Billing | **Paddle** (MoR; Pakistan not on its unsupported list) primary; Shopify Billing for the Shopify-app channel later | Stripe unsupported in Pakistan; Lemon Squeezy is now a Stripe product and mid-migration to "Stripe Managed Payments". |
| Hosting path | v0 local Docker → **v1 Vercel Pro + Neon + a single Hetzner CPX worker** → v2 move web to Hetzner/Coolify or Railway, keep Neon → v3 AWS (ECS Fargate + RDS) or Hetzner cluster | Minimise ops at 100 accounts; cost-optimise at 1k; harden at 10k. |
| Region | **US-East (Vercel `iad1`, Neon `us-east-1/2`, Hetzner Ashburn)** for API/worker; EU client data stays in the same DB with contractual DPA, not a second region, until an EU customer demands residency | Pinterest's API and crawler are US-hosted (crawler IPs 54.236.1.x); the founder's latency from Pakistan is irrelevant to nightly jobs. |

---

## 1. Pinterest API facts that drive the architecture (verified)

| Fact | Value | Source |
|---|---|---|
| Trial tier | 1,000 requests/day **per app** for all requests | [Rate limits](https://developers.pinterest.com/docs/reference/rate-limits/) |
| Standard tier universal | 100 req/s **per user per app** | same |
| Standard `org_analytics` | **60/min per user per app** (user_account analytics, pin analytics, top_pins) | same |
| Standard `org_read` | 1,000/min per user per app (list pins/boards) | same |
| Headers | `x-ratelimit-limit`, `x-ratelimit-remaining`, `x-ratelimit-reset`; 429 semantics not documented; "subject to change without notice" | same |
| Analytics window | `start_date` cannot be >90 days back; `end_date` ≤ 90 days after `start_date` | [user_account analytics](https://developers.pinterest.com/docs/api/v5/user_account-analytics.md), [pin analytics](https://developers.pinterest.com/docs/api/v5/pins-analytics.md) |
| top_pins | `num_of_pins` max 50, category `org_analytics` | [top_pins](https://developers.pinterest.com/docs/api/v5/user_account-analytics-top_pins.md) |
| Pagination | `page_size` default 25, max **250**, `bookmark` cursor | [Pagination](https://developers.pinterest.com/docs/reference/pagination/) |
| Access token | 30 days (`expires_in` 2,592,000) | [Auth & scopes](https://developers.pinterest.com/docs/getting-started/authentication-and-scopes/) |
| Refresh token | **Continuous refresh: 60-day rolling, refresh indefinitely**; automatic for apps created on/after 25 Sep 2025; old 365-day refresh tokens no longer supported | same (note: Ayrshare's third-party guide claims 1-hour access tokens and 365-day refresh; the official page contradicts it — trust the official page) |
| Leaked tokens | Pinterest revokes tokens found by GitHub secret scanning within 24 h | same |
| Standard access review | Requires video demo of OAuth flow and a live integration; no credential/cookie collection | [Pinterest API FAQ](https://community.pinterest.biz/t/frequently-asked-questions-pinterest-api/2083) |
| Crawler | UAs `Pinterest/0.2 (+https://www.pinterest.com/bot.html)` and `Mozilla/5.0 (compatible; Pinterestbot/1.0; ...)`; verify via reverse+forward DNS to `pinterest.com`/`pinterestcrawler.com`; robots.txt must be on the main domain; crawl-delay capped at 1 | [Pinterest crawler](https://help.pinterest.com/en/business/article/pinterest-crawler) |

**Developer Guidelines, verbatim-critical bits** ([source](https://policy.pinterest.com/en/developer-guidelines)):
- "Except for campaign analytics information accessed about your account … you may not store any information accessed through any Pinterest Materials including the API. Instead, call the API each time you need to access information."
- "Don't combine someone's account information with information from other people's accounts … except as required to provide the specified services to our mutual customers."
- Platform insights, benchmarking, competitor research require "explicit written authorization from Pinterest."
- "Only use information from someone's account to provide the services as specified to that person."
- No explicit "delete on disconnect" clause on that page; the nearest is "regularly update data to remove users who have subsequently opted out or revoked consent."

**Implication (important, flag to legal/Pinterest support):** PinPulse's value depends on retaining analytics longer than the API's 90-day window. The guidelines' storage exception is phrased around *analytics*; it is not unambiguous that it covers per-user organic analytics stored by a third-party app. Action: during Standard-access review, ask API Technical Support in writing whether storing a user's own analytics metrics (numbers only, no Pin content/images) for the purpose of providing the service to that user is permitted, and how long. Design (Section 4) assumes "metrics yes, content no, delete on disconnect" and makes retention a per-tenant config so it can be tightened without a schema change.

---

## 2. Tech stack options and trade-offs

### 2.1 Web framework

| | Next.js 16.4 (App Router) | React Router 8 (framework mode; ex-Remix) | SvelteKit 3 |
|---|---|---|---|
| Status (Nov 2026) | 16.4.5 on npm; Cache Components recommended for all apps and default in `create-next-app`; React 19.3; `next upgrade --agent` + agent Skills + `agentFeedback` | 8.5.1; Vite-based; Remix is again a separate framework | 3.1.1 / Svelte 5.57 |
| Fit for a dashboard with server-side data | Server Components + `'use cache'` with `cacheLife('hours')` is exactly a per-tenant analytics dashboard pattern | Loaders/actions; RSC support "not verified" by comparison author | Excellent DX; smaller React ecosystem (shadcn ports exist but lag) |
| Agent friendliness | Vercel ships Skills for agents (`npx skills add vercel/next.js`) and docs `llms.txt` | Good docs, fewer agent-specific tools | Good docs |
| Risk | Vercel-coupled mental model; monolith can grow | Rewrite cost from Next; smaller hiring pool | Smallest hiring pool; chart/UI libs React-first |

Sources: [Next.js 16.4 release (6 Oct 2026)](https://nextjs.org/blog/next-16-4), [Next.js alternatives 2026 (vendor-written, versions checked 4 Nov 2026)](https://temps.sh/blog/nextjs-alternatives-2026).

**Pick: Next.js 16.4.** Reason: the agent tooling (Skills, `--agent` upgrades) directly supports the "AI loops" operating model, and Cache Components give cheap per-tenant dashboard caching without Redis.

UI: shadcn/ui + Tailwind v4 is the current default pairing (multiple 2026 setup guides, e.g. [designrevision](https://designrevision.com/blog/tailwind-nextjs-setup.md)); nothing in my research argues against it.

### 2.2 Charts (annotated time series: changepoints, alert bands, deploy markers)

From the [TanStack Charts comparison matrix](https://tanstack.com/charts/latest/docs/comparison) (17 libraries, gzip sizes measured in a controlled suite):

| Library | Render | Gzip | Annotation story | Verdict |
|---|---|---|---|---|
| Recharts | SVG only | ~157–172 kB | `ReferenceLine/ReferenceArea`; fine for <2k points | Good for small cards; sluggish for 90 days × 200 pins |
| Apache ECharts | Canvas default, SVG optional | ~157–177 kB | `markLine`, `markArea`, `markPoint`, `dataZoom`, brush; SVG renderer gives crisp PDF export | **Pick** |
| Observable Plot | SVG | ~85–94 kB | Declarative marks; great for static/exploratory; weaker interactivity | Good for PDF-only renders |
| visx | SVG | ~49 kB | Everything custom (D3 primitives) | Most control, most agent-written code to maintain |
| uPlot | Canvas | 22 kB | Fast, minimal annotations | Consider for dense raw views |
| TanStack Charts | SVG/Canvas | ~43–50 kB | v1.4.0, legend/tooltip/selection built in | Watch; young |

**Pick: ECharts** for the main anomaly timeline (canvas for interactivity, `renderer: 'svg'` when printing to PDF) and **Recharts** for small KPI sparklines inside shadcn cards. Define a single `SeriesWithAnnotations` TS type in `packages/shared` so both renderers and the Python detector agree on the annotation schema.

### 2.3 Backend shape and where the stats live

| Option | Pros | Cons |
|---|---|---|
| Single Next.js monolith (Route Handlers, Server Actions, Vercel cron) | One deploy, one type system, agent-friendly | Serverless function limits hurt nightly multi-hour sync, Chromium PDFs, and long-lived rate-limit schedulers |
| Next.js + separate Node service (Hono/Fastify/NestJS) | Clean API boundary | Two TS codebases for one founder; NestJS ceremony is heavy (controller/service/module/DTO per endpoint) |
| Next.js + Python FastAPI for everything backend | Stats native | Duplicates auth/billing logic across languages |
| **Modular monolith (Next.js) + Node worker process (same repo, same packages) + one Python stats worker** | Product logic once; long-running jobs on a VPS; stats in Python | Three runtimes to deploy (but two share code) |

Framework facts (vendor benchmark, Encore): Hono ~71k req/s, Fastify ~62k, NestJS-on-Express ~16k; Hono has the tightest TS inference and runs on any runtime; NestJS suits large teams ([source](https://encore.dev/articles/nestjs-vs-fastify-vs-hono)). If an internal HTTP API is needed between worker and web, use **Hono** (also runs in Next.js Route Handlers via `hono/vercel`).

**Stats code placement: Python.** `ruptures` provides Pelt, Binseg, BottomUp, Window, Dynp, KernelCPD with L1/L2/Normal/RBF/AR cost functions, synthetic signal generators and evaluation metrics (precision/recall, Hausdorff, Rand), BSD-2 license ([docs](https://centre-borelli.github.io/ruptures-docs/)). The synthetic generators are exactly what property-based detector tests need. PyMC is unnecessary at v1; use `statsmodels` STL/seasonal decomposition + robust z-scores + PELT, and add Bayesian changepoint only if customers need credible intervals. The Python worker is a **pure function service**: input = series + metadata, output = changepoints + cause-classification features; it never touches Pinterest tokens or the DB (keeps the compliance surface in one place).

### 2.4 Database

| | Neon | Supabase | Self-hosted Postgres (Hetzner) |
|---|---|---|---|
| Entry price | Free: 100 CU-h, 1 GB/project; Launch: $0.106/CU-h, $0.35/GB-mo, PITR up to 7 days, autoscale to 16 CU; "typical" $15 intermittent / $353 high load | Free 500 MB; Pro $25/mo incl. 8 GB + $10 compute credit; compute add-ons Micro $10 → Large (2 vCPU/8 GB) $110; PITR **$100/mo per 7 days** | Included in VPS; you run backups (pgBackRest/WAL-G to object storage) |
| Branching (preview envs for agents) | 10 branches on Free/Launch, $1.50/extra | $0.01344/branch-hour | DIY (template DB + script) |
| Time-series extensions | pg_partman-style scripts; TimescaleDB availability: **verify** | Supabase publishes a "Migrate from TimescaleDB to pg_partman" guide, i.e. it is moving customers off Timescale | Anything (incl. TimescaleDB TSL) |
| RLS | Yes; Drizzle has `crudPolicy`, `authenticatedRole` helpers for Neon | Yes; Drizzle has Supabase role helpers | Yes |
| Risk | Usage-based bill spikes if the worker keeps compute hot all night | PITR pricing; more product than needed | You are the DBA |

Sources: [Neon pricing](https://neon.com/pricing), [Supabase pricing](https://supabase.com/pricing), [Supabase pg_partman migration](https://supabase.com/docs/guides/database/migrating-to-pg-partman.md), [Drizzle RLS docs](https://orm.drizzle.team/docs/rls).

**Volume math (est.)**: rows = accounts × tracked pins × days. Keep ~300 tracked pins/account (top-50 + active set; see §4) and 90 days raw: 100 accounts → 2.7M rows; 1k → 27M; 10k → 270M. At ~120 bytes/row including indexes (date, pin_id, 8 int metrics) that is ~0.3 GB / 3 GB / 32 GB. Derived daily aggregates (per account per day) are negligible. Plain Postgres with **daily or weekly range partitions** on the `pin_metrics_daily` table and `DROP PARTITION` for retention is enough through v3; TimescaleDB's compression (vendor claims up to 95%, [TigerData](https://www.tigerdata.com/learn/pg_partman-vs-hypertables-for-postgres-partitioning)) and continuous aggregates would be nice at 10k but are not available on Neon/Supabase, so defer. **ClickHouse: not at v1** — no ad-hoc cross-tenant analytics are allowed anyway under Pinterest guidelines.

**Multi-tenant RLS pattern** (agency mode): every tenant-scoped table has `org_id`; policies compare to `current_setting('app.org_id', true)`; the app connects as a non-owner role (table owners bypass RLS); `set_config(..., true)` scopes the setting to the transaction so pooled connections (Neon pooler/PgBouncer) never leak; Drizzle Kit does not manage policies, so keep them in a hand-written migration ([pattern source](https://zomer.vercel.app/blog/postgresql-rls-drizzle-multi-tenant-security), [Drizzle RLS API](https://orm.drizzle.team/docs/rls)). Agency ↔ client isolation: `org` (agency) → `workspace` (client) → `pinterest_account`; consent is recorded per workspace; RLS is at the workspace level with an agency-membership join.

### 2.5 Jobs and queues

| | pg-boss | BullMQ (Redis) | Inngest | Trigger.dev | Temporal |
|---|---|---|---|---|---|
| Infra | Postgres ≥13, Node ≥22.12 | Redis (needs `noeviction` or jobs silently lost) | Hosted (OSS self-host possible) | Hosted or self-host (Apache-2.0) | Server + DB; heavy |
| Rate-limit-aware scheduling | Queue storage policies for rate limiting/debounce/concurrency; cron + RRULE; retries w/ exp backoff; DLQ + redrive; priority; deferral | Rate limiter, priorities, retries; whole job reruns | Best-in-class: per-key concurrency, throttle, debounce, priority | Queues with concurrency limits; checkpointing for long waits | Everything, via code |
| Price | Free (MIT) | Free (MIT) + Upstash Redis ($0.20/100k cmds or $10/mo fixed 250 MB) | Free 50k executions/mo (each `step.run` counts); Pro from **$99** (1M) | Free $5 credit; Hobby $10; Pro **$50** incl. $50 compute; Small-1x $0.0000338/s; $0.25/10k runs | Cloud bills per action |
| Fit | **Pick for v1** | Fine if Redis already present (it won't be) | Great DX, but per-step billing punishes per-pin calls unless batched | Good self-host option for data residency | Overkill |

Sources: [pg-boss](https://github.com/timgit/pg-boss), [Inngest pricing](https://www.inngest.com/pricing), [Trigger.dev pricing](https://trigger.dev/pricing), [Upstash Redis pricing](https://upstash.com/pricing/redis), [2026 comparison](https://www.devtoolreviews.com/reviews/temporal-vs-inngest-vs-trigger-dev-vs-bullmq-2026).

**Pick: pg-boss** behind a tiny `JobRunner` interface (`enqueue`, `schedule`, `onJob`). The rate limiter itself is **not** the queue's job: implement a per-token token-bucket in Postgres (`pinterest_rate_state(account_id, window_start, used)`) because the limit is per user per app (§4). If you later want hosted observability, Trigger.dev's compute model prices a 1k-account nightly at ~$46/mo (est., 45 s/account × 1k × 30 × $0.0000338/s), which fits its Pro plan; Inngest would need per-account batching to stay off per-pin execution billing.

### 2.6 Auth and Pinterest token storage

- **Lucia**: "no longer maintained … consider using better-auth instead." **Auth.js/NextAuth v5**: still most downloaded, `@auth/core` rewrite, but no built-in 2FA and manual session type augmentation. **Better Auth**: ~3 releases/week, `organization()` plugin (orgs/members/invitations), 2FA, passkeys, admin/RBAC, Drizzle adapter ([pkgpulse comparison](https://www.pkgpulse.com/guides/better-auth-vs-lucia-vs-nextauth-2026)). **Clerk**: hosted, fine, but per-MAU pricing and a vendor dependency a solo founder does not need for B2B seats.
- Better Auth's `generic-oauth` plugin supports `providerId`, `authorizationUrl/tokenUrl`, `scopes`, PKCE by default, `accessType: "offline"`, `accessTokenExpiresIn` fallback, and `getAccessToken` refresh; it does **not** document token encryption ([docs](https://www.better-auth.com/docs/plugins/generic-oauth)). Pinterest's refresh-token rotation (new refresh token on each refresh, 60-day rolling) means you must persist the new token atomically.
- **Decision**: use Better Auth only for *user login + orgs*. Store **Pinterest connections in your own `pinterest_connection` table**, not in Better Auth's `account` table, so you control encryption, rotation, scopes, and deletion:
  - Envelope encryption: per-connection random data key (AES-256-GCM) encrypting `access_token`/`refresh_token`; data key wrapped by a KEK held in a KMS (AWS KMS ≈ $1/key/month + per-request (est., verify current price) or, at v1, a KEK in the secrets manager with a documented rotation runbook). Columns: `ciphertext`, `iv`, `tag`, `kek_version`.
  - Refresh job every 20 days (access) / on every refresh rotate refresh token; alert at 50 days without successful refresh; mark `needs_reauth`.
  - Never log tokens; Sentry `beforeSend` scrubber; Pinterest revokes GitHub-leaked tokens within 24 h — add `gitleaks` pre-commit and CI.

### 2.7 Email, Slack
- Resend: Free 3,000/mo (100/day cap), Pro $20 for 50k, $35 at 100k. Postmark: Basic $15 for 10k, $55 at 50k, $115 at 100k, manual account approval, separate transactional/broadcast streams ([source](https://devtoolpicks.com/blog/resend-vs-postmark-vs-mailgun-solo-developers-2026)). **Pick Resend**; revisit Postmark if deliverability of alerts becomes a complaint.
- Slack: incoming webhooks per workspace (store webhook URL encrypted like a token; it is a bearer credential).

### 2.8 PDF generation

| | Playwright/Chromium | @react-pdf/renderer | Typst |
|---|---|---|---|
| Fidelity | Full HTML/CSS, same React chart components as dashboard | Flexbox-only CSS subset; charts need re-implementation | Excellent typography; charts not covered in sources; CJK immature |
| Cost | ~100 MB Chromium, 400–600 MB peak, 2–5 s/PDF, breaks serverless size limits | ~2 MB, <500 ms, works on Vercel | Rust lib, light; ecosystem early (Papermake v0.3) |
| Verdict | **Pick, run on the worker VPS** | Fallback for synchronous downloads | Watch |

Sources: [Puppeteer vs react-pdf production comparison](https://dev.to/iurii_rogulia/pdf-generation-on-the-server-puppeteer-vs-react-pdfrenderer-a-production-comparison-44cg), [Typst/Papermake analysis](https://braindetox.kr/en/posts/papermake_typst_pdf_server_2026.html). Monthly reports and evidence packs are async jobs anyway (email a link), so Chromium on the worker is the right trade.

### 2.9 Observability, flags, support, status

| Tool | Free tier | Paid entry | Source |
|---|---|---|---|
| Sentry | Developer: 1 user, 5k errors, 5M spans, 50 replays, 1 cron + 1 uptime monitor | Team $29/mo (unlimited users, 50k errors) | [pricing](https://sentry.io/pricing/) |
| Grafana Cloud | 50 GB logs, 50 GB traces, 10k series, 3 users | Pro $19 platform fee + usage | [pricing](https://grafana.com/pricing/) |
| Axiom | Personal: 500 GB/mo ingest, 30-day retention | Cloud $25/mo + usage | [pricing](https://axiom.co/pricing) |
| Better Stack | Uptime: 10 monitors + 1 status page; Logs/Traces 3 GB each, 3-day retention | +50 monitors $25; Telemetry Nano $30/mo | [pricing](https://betterstack.com/pricing) |
| PostHog | 1M events, 5k replays, 1M flag requests, 100k exceptions, 1.5k survey responses /mo | usage | [pricing](https://posthog.com/pricing) |
| Crisp | Free 2 seats | Mini $45 (4 seats), Essentials $95 | [pricing](https://www.eesel.ai/blog/crisp-pricing) |

**Pick**: Sentry (errors + cron monitors for the nightly job — note extra cron monitors are $0.78 each), OpenTelemetry SDK in Next.js and the workers → Grafana Cloud Free (switch to Axiom if you prefer its query UX; both are OTel-native), Better Stack Uptime + its free status page, PostHog for product analytics and feature flags (also usable as a kill-switch for the detector per tenant), Crisp Free for chat/support. Plain is a better "B2B support inbox" later but I could not fetch its pricing (page errored); treat as unverified.

### 2.10 Billing (Pakistan-based founder)
- Paddle: 5% + $0.50 per checkout, MoR handles VAT/sales tax; Pakistan is **not** on Paddle's unsupported-countries list and Paddle markets to Pakistani sellers ([unsupported list](https://www.paddle.com/help/start/account-verification/which-countries-are-supported-by-paddle), [Paddle Pakistan page](https://www.paddle.com/billing/pakistan)); verification may request extra documents.
- Lemon Squeezy: same 5% + $0.50, but Stripe acquired it in 2024, announced "Stripe Managed Payments" in Jan 2026 and shipped it into Stripe's API by Apr 2026 ([Dodo analysis](https://dodopayments.com/blogs/paddle-vs-lemon-squeezy/)); given Stripe does not support Pakistan sellers, treat LS as a migration risk.
- Shopify Billing: 0% revenue share on first $1M lifetime (post-1 Jan 2025 revenue), 15% after, plus 2.9% processing; $19 one-time registration ([Shopify revenue share](https://shopify.dev/docs/apps/launch/distribution/revenue-share.md)). Use only for a Shopify-App-Store listing of the Shopify-order-join feature.
- **Pick: Paddle** now; keep a `BillingProvider` interface so Shopify Billing can be added for the Shopify channel.

---

## 3. Deployment plan with costs

Assumptions for cost (est.): web traffic is tiny relative to sync work; nightly sync dominates compute; storage from §2.4; Hetzner prices are EUR excl. VAT and the CX/CAX lines were **unorderable in Oct 2026 checks** after +70–84% price rises, so I price on the orderable CPX Gen2 line (CPX22 2 vCPU/4 GB €19.49; CPX32 4/8 €35.49; CPX42 8/16 €69.49; 20 TB traffic; +€0.50 IPv4) ([bitdoze Oct 2026](https://www.bitdoze.com/hetzner-cloud-cost-optimized-plans/)). Fly: shared-cpu-1x 1 GB $6.70/mo in `iad` ($8.50 in `sin`), Managed Postgres from $38/mo, volumes $0.15/GB ([Fly pricing](https://docs.fly.io/about/pricing)). Railway: ~$10/GB RAM-month, ~$20/vCPU-month, Hobby $5 min, Pro $20 min ([Railway pricing](https://railway.com/pricing)). Vercel: Hobby $0 (non-commercial), Pro $20 incl. $20 credit, Fluid active CPU $0.128/h ([Vercel pricing](https://vercel.com/pricing)).

### 3.1 Monthly cost by option (USD, est.; excludes Sentry/Resend/PostHog free tiers and Paddle fees)

| Option | 0 accounts (dev) | 100 | 1,000 | 10,000 |
|---|---|---|---|---|
| **A. Vercel Pro + Neon Launch + Hetzner CPX worker** (recommended v1) | $0 (local Docker + Neon Free) | Vercel $20 + Neon ~$15–30 + CPX22 ~$22 = **~$60–75** | Vercel $20–40 + Neon ~$60–120 (≈3 GB, compute hot ~6 h/night) + CPX32 ~$40 = **~$130–200** | Vercel $40–80 + Neon ~$350–700 ("high load" Launch/Scale examples) + 2× CPX42 ~$155 = **~$550–950** |
| B. Railway (web+worker+Postgres) | $5 | ~$25–40 | ~$120–200 (2 vCPU/4 GB web, 2 vCPU/4 GB worker, 4 GB-RAM Postgres + volume) | ~$600–1,000 |
| C. Fly.io (machines + Managed Postgres) | ~$7 | ~$60 (2 small machines + MPG Basic $38) | ~$150–250 | ~$700–1,200 |
| D. Hetzner + Coolify (all-in-one, you are the DBA) | €0 | CPX32 ~$40 + backups 20% + S3 backups ~$5 = **~$50** | CPX42 app+worker + CPX32 Postgres ≈ **~$125** + backups | 3× CPX42 + CPX62 DB (~$140) + LB ≈ **~$400–500** |
| E. AWS ECS Fargate + RDS (v3 only) | n/a | n/a | ~$300–500 | ~$1,000–2,000 (RDS db.m7g.large Multi-AZ + Fargate + NAT + S3) |

Reading: A costs more than D at every scale but removes DB ops and gives DB branching for agent preview environments. The crossover where D's savings justify DBA time is around 1k accounts; at 10k, Neon's usage bill (not Vercel's) is the line item to attack, by moving the sync workload's heavy writes to a self-managed Postgres or RDS.

### 3.2 Staged plan

**v0 — local/dev (now → first users)**
- Docker Compose: Postgres 16, Next.js, Node worker, Python worker (`uv`), Mailpit, a fake Pinterest API (recorded fixtures via Prism/MSW) so agent loops never burn the 1,000/day Trial quota.
- Neon Free branch for cloud preview; Vercel Hobby only for non-commercial previews (its terms forbid commercial use; move to Pro before charging).
- Apply for Standard access early: the review needs a video of OAuth + live integration ([FAQ](https://community.pinterest.biz/t/frequently-asked-questions-pinterest-api/2083)).

**v1 — first 100 accounts**
- Vercel Pro (`iad1`) for web; Neon Launch (`us-east`) with PITR 7 days; one Hetzner CPX22/CPX32 in **Ashburn** running Node worker + Python worker + Chromium via Coolify or plain Docker Compose + systemd; Upstash not needed (pg-boss).
- CI/CD: GitHub Actions → Vercel preview per PR with a **Neon branch per PR** (Neon's GitHub integration); worker deploys by `docker compose pull && up -d` over SSH (Coolify handles this with a UI, per-branch previews and automated DB backups; it is Apache-2.0, 62k stars, v4.4.6 ([comparison](https://wz-it.com/en/blog/self-hosted-paas-comparison-coolify-dokploy-caprover/))). Kamal is the IaC-flavoured alternative if you prefer YAML over a dashboard.
- Secrets: Vercel env + Doppler/Infisical or 1Password CLI injecting into the worker; never in Coolify UI only.
- Backups: Neon PITR + nightly `pg_dump` to Backblaze B2/Cloudflare R2 (cheap, off-provider).
- Rollouts: Vercel atomic deploys; worker rolling restart (jobs are idempotent and resumable by design).
- IaC: none beyond `docker-compose.yml` and a `terraform/` folder for Hetzner server + firewall + Neon project (Neon has a Terraform provider; keep it small).

**v2 — 1,000 accounts**
- Move web to the Hetzner box(es) behind Coolify/Traefik **or** stay on Vercel if the bill is <$60; move Postgres to a dedicated CPX32/CPX42 with pgBackRest → R2, or keep Neon if usage bill <$150. Add a read replica only if dashboards contend with the nightly load.
- Split the worker into `sync` and `stats`/`pdf` containers; enable weekly partitions + partition drop; add Sentry cron monitors for every scheduled job; Better Stack status page public.
- Terraform for Hetzner + DNS (Cloudflare) + R2 buckets; GitHub Environments with required reviewers for `production`.

**v3 — 10,000 accounts**
- Choose: (a) Hetzner 3-node (app ×2 + DB) with Kamal/Coolify multi-server and Patroni or managed-by-you failover, or (b) AWS `us-east-1` ECS Fargate + RDS Postgres Multi-AZ + S3 + KMS, Terraform/SST. (b) buys an audit-friendly story (KMS, CloudTrail) for SOC 2-lite and enterprise agencies. EU residency only if contractually demanded: then a second stack in `eu-central-1`/Falkenstein with tenant pinning, not cross-region replication.
- Consider TimescaleDB (self-managed) or ClickHouse only if per-pin raw retention is extended beyond 90 days for paying tiers.

Region rationale: Pinterest's crawler is US-based (54.236.1.x) and its API is US-served; your nightly jobs are latency-insensitive; EU VAs/agencies care about GDPR *processing terms* (DPA, SCCs) more than physical location at this scale. Pick US-East and ship a DPA.

---

## 4. Rate-limit math, scheduling, caching and retention

### 4.1 Nightly call budget per account (Standard tier)

Per connected account with `P` pins and `T` tracked pins (T ≤ P):
- 1 × `user_account/analytics` (90-day window in one call) — org_analytics
- 1 × `user_account/analytics/top_pins` (50 pins) — org_analytics
- 1 × `user_account/analytics/top_video_pins` (optional) — org_analytics
- ⌈P/250⌉ × `pins` list — org_read (1,000/min, never the bottleneck)
- T × `pins/{id}/analytics` — org_analytics (the only thing that matters)

Limits are **per user per app**, so N accounts are N independent 60/min buckets; there is no documented app-wide cap on Standard. Your app-wide constraint is your own worker concurrency and the 100 req/s per-user universal limit (irrelevant at 1/s).

| Tracked pins T | Minutes per account at 60/min | Accounts finishable per worker-stream in 8 h |
|---|---|---|
| 50 (top_pins only) | ~1 | ~480 |
| 300 | 5 | 96 |
| 1,000 | ~17 | 28 |
| 5,000 | ~84 | 5.7 |

Fleet math (est.): 10k accounts × 300 tracked pins = 3M org_analytics calls/night. With C concurrent account streams at 1 call/s each, wall time = 3M / (C × 3,600) hours → C=100 gives 8.3 h; C=150 gives 5.6 h. 150 concurrent HTTP streams at ~300 ms each is ~150 rps outbound — one Node process with p-limit per account handles it; the Postgres write rate (~150 rows/s batched) is trivial.

### 4.2 Tracked-pin policy (keeps T ≈ 300 instead of P)
1. Always: account aggregate + top-50 (top_pins) daily.
2. Active set daily: pins created in the last 90 days, pins that appeared in top-50 in the last 30 days, pins with impressions > tenant median over last 7 days, pins the user starred/alerted on.
3. Long tail: 1/7 of remaining pins each night (weekly cadence), using a 14-day window so no days are missed.
4. Hard cap per tier (e.g. 300/1,000/5,000) exposed as a plan feature; over-cap accounts degrade to weekly.

### 4.3 Scheduler design (pg-boss + per-token bucket)
- `nightly_plan` cron (00:30 UTC) enumerates accounts → one `sync_account` job per account with priority by plan and `singletonKey=account_id`.
- `sync_account` opens a per-account token bucket row (`capacity 60, refill 60/min`), reads `x-ratelimit-remaining`/`x-ratelimit-reset` from each response and **trusts the header over the local bucket** (limits "subject to change without notice").
- On 429 or when `remaining=0`: sleep until `reset`, then continue; on 5xx: exponential backoff 1s→2s→4s→… ×5 with jitter; on 401 error code 2: mark `needs_reauth`, stop, notify.
- Jobs are resumable: progress cursor (`last_pin_index`, `bookmark`) stored on the job row; a worker restart just re-queues from the cursor (pg-boss retries with exp backoff + DLQ + redrive).
- Late data: Pinterest metrics for the last 1–3 days can change (**assumption**, observed with most social APIs); re-pull the last 3 days with every daily call and upsert on `(account_id, pin_id, date)`.

### 4.4 Trial-tier reality (development only)
1,000 req/day **per app**. Reserve ~200 for OAuth/refresh/list; the remaining ~800 covers e.g. 5 test accounts × (2 account calls + 50 top-pin calls) × 3 days of re-pull overlap. Treat Trial as fixture-recording budget, not a product tier; all agent-loop tests must hit recorded fixtures.

### 4.5 Caching and retention design (consistent with "call the API each time")

| Data class | What | Retention | Rationale |
|---|---|---|---|
| Pinterest *content* (titles, descriptions, images, board names) | Fetched for display | **Not persisted**; fetched on demand via `org_read` (1,000/min) and cached in-memory/`'use cache'` ≤ 1 h | Matches "call the API each time" for content |
| Raw metrics (per pin per day) | numbers only | **Rolling 90 days**, matching the API's own window, dropped by partition | Mirrors what the user could re-fetch; arguably a cache |
| Derived (account daily rollups, anomalies, changepoints, cause labels, report snapshots, evidence packs) | your computed outputs | 13 months by default; user-configurable; deleted on disconnect | Needed for YoY and for support tickets; these are PinPulse's work product, but still delete on disconnect |
| Tokens | encrypted | Until disconnect/revoke; refresh tokens 60-day rolling | §2.6 |
| Audit log | who did what | 12 months, then cold storage | Agency accountability |

Disconnect = user action, agency removal, OAuth 401 with no re-auth in 14 days, or Pinterest-side revoke: immediately revoke token (`DELETE` at Pinterest if API offers it; otherwise drop locally), soft-delete connection, enqueue `purge_connection` that hard-deletes metrics/derived/reports within 24 h and writes an audit entry; nightly job asserts no rows exist for purged connections. Pinterest's page does not state a deadline; 24 h is my design target. Get written confirmation from Pinterest API support on the metrics-retention question (§1).

---

## 5. Security and compliance

**OAuth tokens** — see §2.6; add: scope minimalism (`user_accounts:read, pins:read, boards:read`; add `*:read_secret` only on user opt-in), state+PKCE on every authorize, encrypt Slack webhooks the same way, token access through one `TokenVault` module with structured audit (`who, connection_id, purpose`).

**Secrets rotation** — KEK versioning column; rotation = re-wrap data keys, not re-encrypt rows; Pinterest app secret reset does not invalidate existing tokens ([auth docs](https://developers.pinterest.com/docs/getting-started/authentication-and-scopes/)), so rotate it quarterly; GitHub Actions use OIDC federation to Anthropic/AWS rather than long-lived keys ([claude-code-action docs](https://code.claude.com/docs/en/github-actions)).

**SOC 2-lite checklist (solo-founder version)** — (1) SSO/2FA on GitHub, Vercel, Neon, Hetzner, Paddle, Sentry; (2) branch protection + required CI + signed commits; (3) Dependabot weekly grouped updates, Trivy FS + image scans uploaded as SARIF, fail build on fixable HIGH/CRITICAL, CycloneDX SBOM per release via `anchore/sbom-action` ([reference setup](https://oneuptime.com/blog/post/2026-01-30-dependency-scanning-integration/view)); (4) `gitleaks` in pre-commit and CI; (5) encrypted backups tested quarterly by restore; (6) access review quarterly (you + any contractor); (7) incident runbook + status page; (8) vendor list with DPAs (Vercel, Neon, Hetzner, Resend, Sentry, PostHog, Paddle); (9) written data-retention and deletion policy mirroring §4.5; (10) logging of admin actions. Buy Vanta/Drata only when an agency asks for a report.

**GDPR data-subject deletion workflow** — a `/account/delete` self-serve path and a `privacy@` intake; one `erase_subject(user_id)` job that: revokes Pinterest tokens, purges connections (§4.5), deletes Better Auth user/sessions, anonymises audit rows (keep event, hash the actor), deletes Resend/PostHog/Crisp person records via their APIs, and emits a completion receipt; target 30 days, practice 72 h. Agency mode: the agency is controller for its clients' data; your DPA names you processor; sub-processor list published.

**Agency audit logs** — append-only `audit_event(org_id, workspace_id, actor_id, action, target, ip, ua, at, before/after jsonb)`, written from a single `audit()` helper, RLS-visible to org admins, exported as CSV in evidence packs.

**Rate limiting your own API/UI** — per-IP and per-user token bucket at the edge (Vercel WAF rules or Hono middleware backed by Postgres `rate_limit` table; add Upstash only if you need sub-ms global limits); login/OAuth callback endpoints stricter.

**Shopify webhooks** — verify `X-Shopify-Hmac-Sha256` = base64(HMAC-SHA256(raw body, app secret)) with `crypto.timingSafeEqual` on the raw body before parsing; respond 200 within 5 s and process async; Shopify retries 8× over 4 h then deletes the subscription; App Store apps must handle `customers/data_request`, `customers/redact`, `shop/redact` ([Hookdeck guide](https://hookdeck.com/webhooks/platforms/shopify-webhooks-best-practices-revised-and-extended)). Enqueue the raw payload into pg-boss and return immediately.

**Pinterestbot link checks** — fetch the user's own URLs with the exact UA strings above; follow redirect chains (cap 10), record each hop/status/latency, parse `robots.txt` from the apex domain only (subdomains unsupported by Pinterest), detect `disallow` for `Pinterestbot`, check claimed-domain status via `GET /v5/user_account/websites` (exists in the v5 collection; details unverified due to a fetch error). Run these from the worker, respect the site's `Crawl-delay`, never more than 1 req/s per domain, identify yourself truthfully in a secondary header (`X-PinPulse-Check: 1`) so you are not impersonating Pinterest for anything but UA-based content negotiation.

---

## 6. Agent-driven development operating model ("loop engineering")

### 6.1 What the sources say (2025–2026)

- **Anthropic, "Effective harnesses for long-running agents" (26 Nov 2025)**: initializer agent writes an init script, a progress file and an initial commit; the spec is expanded into a **JSON feature list** where agents may only flip `passes`; one feature per session; commit after each; **browser-automation end-to-end checks** caught far more bugs than unit tests/curl; every session starts by reading progress notes + git log + feature list and running a smoke test ([source](https://anthropic.com/engineering/effective-harnesses-for-long-running-agents)).
- **Anthropic, "Scaling Managed Agents" (8 Apr 2026)**: harness is a stateless loop; sandboxes disposable; **credentials never in the sandbox** (git token used at clone time, MCP OAuth tokens behind a proxy vault); session = append-only event log ([source](https://anthropic.com/engineering/managed-agents)).
- **Claude Code best practices (official docs)**: give Claude a verifiable check; keep `CLAUDE.md` short and prune rules it ignores; allowlists/`/sandbox`; explore→plan→code→commit; writer/reviewer in separate sessions; git worktrees for parallel sessions; skills in `.claude/skills/<name>/SKILL.md`; hooks for must-always-happen actions; subagents in `.claude/agents/`; after two failed corrections, restart with a better prompt ([source](https://www.anthropic.com/engineering/claude-code-best-practices)).
- **Hooks**: `PreToolUse` (exit 2 blocks), `PostToolUse` (lint after `Edit|Write`), `Stop` (exit 2 keeps Claude working until tests pass, with a loop guard), `SessionStart` (inject branch/CI facts), `PermissionRequest`, `SubagentStop`, `WorktreeCreate`; handlers can be command/http/mcp_tool/prompt/agent ([hooks docs](https://code.claude.com/docs/en/hooks)).
- **Subagents**: Markdown + frontmatter (`name, description, tools, model, permissionMode, maxTurns, isolation: worktree, hooks, mcpServers`); built-in Explore/Plan; 20 concurrent by default, depth 3; only the summary returns ([subagents docs](https://code.claude.com/docs/en/sub-agents)).
- **Sandboxing**: OS-enforced (bubblewrap on Linux, Seatbelt on macOS), write-restricted to the project, network via allowlisted-domain proxy, `strictAllowlist`, credential `deny`/`mask` with `injectHosts`, `allowUnsandboxedCommands:false` to forbid escape; MCP servers and hooks run **outside** the sandbox ([sandboxing docs](https://code.claude.com/docs/en/sandboxing)).
- **Unattended operation in 2026**: auto mode (classifier-gated permissions; managed `permissions.deny` is absolute), background sessions with `claude agents` dashboard and `/goal` completion checks, dynamic workflows coordinating many subagents ([implicator.ai roundup of v2.1.72–2.1.166](https://www.implicator.ai/anthropic-turned-claude-code-into-an-unattended-agent-runtime-this-spring/)). Agent teams (research preview): lead + teammates with shared task list and mailbox; good for parallel review angles, bad for same-file edits; teammates inherit permissions ([Addy Osmani](https://addyosmani.com/blog/claude-code-agent-teams/)).
- **Ralph loop** (Geoffrey Huntley, Jul 2025): `while` loop feeding `PROMPT.md`, `prd.json` with `passes` flags, `progress.txt` learnings, iteration cap; acceptance criteria must be machine-verifiable; costs can exhaust subscriptions in days; agents may quietly skip/delete failing tests ([Geocodio write-up, Jan 2026](https://www.geocod.io/code-and-coordinates/2026-01-27-ralph-loops)).
- **Spec-driven development**: GitHub Spec Kit (MIT, Python/uv CLI `specify init`, commands `/speckit-constitution|specify|plan|tasks|implement|converge`, plus bug-fix and assess commands; "Spec Kit 1.0" discussed Oct 2026) vs Kiro specs (`requirements/design/tasks`, EARS acceptance criteria, tied to Kiro IDE) ([Spec Kit](https://github.com/github/spec-kit), [comparison](https://docs.plannotator.ai/compare/github-spec-kit-vs-kiro-specs)).
- **GitHub Actions**: `anthropics/claude-code-action@v1`; interactive (`@claude`) vs automation (`prompt`) mode; official `code-review` plugin posts inline comments with `--comment`; write-access and human-actor checks; `--max-turns`, workflow timeouts, concurrency controls for cost; OIDC federation instead of stored keys ([docs](https://code.claude.com/docs/en/github-actions)).
- **MCP servers**: Postgres (`modelcontextprotocol/servers` — use a read-only role), Playwright MCP (Microsoft, accessibility-tree based), Sentry remote MCP (`mcp.sentry.dev`, OAuth), GitHub MCP (official, read-only/lockdown modes) ([roundup](https://dupple.com/learn/best-mcp-servers-claude-code)).
- **Metrics**: autonomy rate (agent PRs merged without human rewrite), intervention rate, wasted-run rate, cycle time split agent/human, defect/rollback rate; compare against a pre-agent baseline; no single metric suffices ([Warp](https://www.warp.dev/articles/metrics-that-prove-ai-coding-agents-are-working)).

### 6.2 PinPulse operating model

**Roles**: you are product owner, spec author, reviewer and release manager. Agents do: exploration, implementation, test writing, first-pass review, docs, migration drafting.

**Artifacts**
- `CLAUDE.md` (≤150 lines): commands (`pnpm test`, `pnpm e2e`, `uv run pytest`), repo map, non-negotiables (never touch `migrations/` without a spec; never add network calls to Pinterest outside `packages/pinterest-client`; never store Pin content), links to `docs/specs/*`.
- `docs/constitution.md` (Spec Kit style): Pinterest guideline rules, tenancy rules, test policy ("it is unacceptable to remove or edit tests"), definition of done.
- `docs/specs/<feature>/{spec.md,plan.md,tasks.json}` — `tasks.json` is the machine-checked feature list with `passes` and `verify` commands (the Anthropic/Ralph pattern).
- `progress/<feature>.md` learnings log.

**The loop (per feature)**
1. **Spec** (human + Claude in plan mode): `/speckit-specify` → `spec.md` with EARS-style acceptance criteria, each mapped to a `verify` command (unit, property, contract, e2e).
2. **Plan/tasks** (Claude): `plan.md`, `tasks.json`; human approves.
3. **Implement** (automated loop, one task per fresh session, in a git worktree): `claude -p` or a background session with `/goal "all tasks in tasks.json pass"`, sandbox on, `strictAllowlist` to `registry.npmjs.org, pypi.org, github.com`, credentials `deny`, iteration cap 10–15 per task, `--max-turns`, cost ceiling per night.
4. **Test** (hooks): `PostToolUse Edit|Write` → biome/ruff; `Stop` → `pnpm turbo test --filter=...[HEAD~1]` exit 2 on failure with loop guard; `PreToolUse Bash(git push *)` → ask.
5. **Review** (fresh-context reviewer subagent, read-only tools, then `claude-code-action` code-review on the PR); second reviewer angle for security (token handling, RLS) as a separate subagent.
6. **Merge** (human): required checks green, CodeQL/Trivy clean, migration reviewed by you, preview env (Vercel + Neon branch) smoke-tested via Playwright MCP by an agent, then you click merge. Humans must still: approve specs, review migrations and anything touching tokens/RLS/billing, read every PR diff touching `packages/pinterest-client`, run the Pinterest Standard-access video, handle legal and vendor relationships, own incidents.

**Quality gates (CI)**: typecheck → lint → unit (vitest) + Python (pytest + hypothesis property tests on detectors with ruptures' synthetic generators) → contract tests against recorded Pinterest fixtures (Prism/MSW) → migration dry-run on a Neon branch → Playwright e2e against preview → Trivy/gitleaks/SBOM → Sentry release.

**Metrics to log per agent run** (write to a `agent_runs` table or a CSV in `metrics/`): task id, model, turns, tokens/cost, CI pass on first push (y/n), review iterations, human rewrite lines %, merged (y/n), reverted within 14 days (y/n). Report weekly: task success rate, first-CI-pass rate, rework rate (human-changed lines / agent lines), revert rate, cost per merged task.

**Guardrails**: sandbox on with `allowUnsandboxedCommands:false`; Postgres MCP via read-only role against a dev branch only; no production secrets on dev machines (Doppler scoped tokens); `permissions.deny` for `Bash(rm -rf *)`, `Bash(docker *)` outside the compose wrapper, writes to `.github/workflows` and `migrations/` unless the session is tagged for it; Sentry MCP read-only; GitHub MCP in read-only mode in automated sessions; a hook that rejects any diff deleting a test file.

---

## 7. Repo skeleton (pnpm workspaces + Turborepo, with uv for Python)

```
pinpulse/
├── CLAUDE.md
├── .claude/
│   ├── settings.json            # sandbox, hooks, permissions.deny
│   ├── agents/                  # implementer.md, reviewer.md, security-reviewer.md, e2e-tester.md
│   ├── skills/                  # /spec, /task, /release, /fixture-record
│   └── hooks/                   # lint.sh, test-gate.sh, no-test-delete.sh
├── .mcp.json                    # postgres(ro, dev branch), playwright, sentry, github(ro)
├── docs/
│   ├── constitution.md
│   ├── specs/<feature>/{spec.md,plan.md,tasks.json}
│   └── adr/                     # ADR-001 stack, ADR-002 retention, ADR-003 queue
├── apps/
│   └── web/                     # Next.js 16.4, Better Auth, ECharts, Server Actions
├── services/
│   ├── worker/                  # Node: pg-boss workers (sync, alerts, pdf, link-checks)
│   └── analytics/               # Python/uv FastAPI: detectors, cause classifier (pure functions)
├── packages/
│   ├── db/                      # Drizzle schema, RLS policies (hand-written SQL migrations), partition scripts
│   ├── pinterest-client/        # typed v5 client, rate-limit buckets, fixtures recorder/replayer
│   ├── shared/                  # zod schemas + TS types (SeriesWithAnnotations, Alert, Tenant), OpenAPI for analytics service
│   ├── ui/                      # shadcn components, chart wrappers, report templates (shared with PDF)
│   └── config/                  # biome, tsconfig, tailwind presets
├── infra/
│   ├── docker/                  # compose.dev.yml, compose.prod.yml, Dockerfiles (web, worker, analytics+chromium)
│   └── terraform/               # hetzner, cloudflare DNS, r2, neon
├── fixtures/pinterest/          # recorded JSON responses (scrubbed), versioned by API date
├── .github/
│   ├── workflows/ci.yml, deploy-worker.yml, claude.yml, claude-code-review.yml, release.yml
│   └── dependabot.yml
├── turbo.json  pnpm-workspace.yaml  package.json  pyproject.toml  uv.lock  biome.json
```

Turborepo's Python support is experimental (`experimentalPythonWorkspaces`; maps Ruff/mypy/pytest to tasks; hashes `uv.lock`) ([docs](https://turborepo.dev/docs/guides/tools/python)); if it is flaky, wrap `uv run pytest` in `services/analytics/package.json` scripts instead.

**CI outline (`.github/workflows/ci.yml`)**
```yaml
on: [pull_request, push: {branches: [main]}]
concurrency: {group: ci-${{ github.ref }}, cancel-in-progress: true}
jobs:
  js:
    runs-on: ubuntu-latest
    steps: [checkout, pnpm/action-setup, setup-node 22 (cache pnpm), pnpm i --frozen-lockfile,
            pnpm turbo typecheck lint test --filter=...[origin/main]]
  py:
    steps: [checkout, astral-sh/setup-uv, uv sync, uv run ruff check, uv run mypy, uv run pytest -q --hypothesis-profile=ci]
  contract:
    services: {postgres: postgres:16}
    steps: [migrate (drizzle-kit), start mock Pinterest (prism fixtures/pinterest/openapi.yaml), pnpm test:contract]
  e2e:
    needs: [js, py]
    steps: [neondatabase/create-branch-action (PR branch), vercel preview (or compose up), playwright install --with-deps, pnpm e2e]
  security:
    steps: [gitleaks/gitleaks-action, aquasecurity/trivy-action (fs, severity HIGH,CRITICAL, ignore-unfixed, sarif),
            github/codeql-action, anchore/sbom-action (cyclonedx, on main/release)]
  agent-review:   # separate workflow claude-code-review.yml using anthropics/claude-code-action@v1 + code-review plugin
```

**Test strategy**
- Unit (vitest / pytest): client, schedulers, alert rules, token vault (encrypt→decrypt roundtrip, KEK rotation).
- Property-based (hypothesis + ruptures synthetic signals): for random piecewise-constant series with known breakpoints and noise, detector recall ≥ X and precision ≥ Y within ±2 days; no changepoints on stationary noise at FPR ≤ Z; invariance to scale; monotone response to effect size. These numbers become the shipped SLO of the detector.
- Contract tests: every `pinterest-client` method replayed against recorded fixtures with headers (`x-ratelimit-*`), 429/401/5xx cases, pagination to `bookmark:null`; a nightly "fixture drift" job re-records a small sample on a dev token and diffs schemas.
- Integration: pg-boss jobs against Postgres with fake clock; RLS tests that assert cross-tenant queries return zero rows for each policy.
- E2E (Playwright): OAuth connect (mock Pinterest OAuth server), dashboard loads, alert configured, PDF generated and contains expected text, disconnect purges data (assert via admin API). Agents use Playwright MCP for exploratory checks; CI uses deterministic specs.

---

## 8. Source list

Pinterest
- https://developers.pinterest.com/docs/reference/rate-limits/
- https://developers.pinterest.com/docs/getting-started/authentication-and-scopes/
- https://developers.pinterest.com/docs/api/v5/user_account-analytics.md
- https://developers.pinterest.com/docs/api/v5/pins-analytics.md
- https://developers.pinterest.com/docs/api/v5/user_account-analytics-top_pins.md
- https://developers.pinterest.com/docs/api/v5/pins-list.md
- https://developers.pinterest.com/docs/reference/pagination/
- https://policy.pinterest.com/en/developer-guidelines
- https://community.pinterest.biz/t/frequently-asked-questions-pinterest-api/2083
- https://help.pinterest.com/en/business/article/pinterest-crawler
- (could not fetch) https://policy.pinterest.com/en/developer-terms
- (third-party, conflicting token claims) https://www.ayrshare.com/solutions/pinterest-api-v5-transition-the-complete-developer-guide/

Frameworks / UI / charts
- https://nextjs.org/blog/next-16-4
- https://temps.sh/blog/nextjs-alternatives-2026
- https://tanstack.com/charts/latest/docs/comparison
- https://encore.dev/articles/nestjs-vs-fastify-vs-hono
- https://designrevision.com/blog/tailwind-nextjs-setup.md

Data / jobs / auth
- https://neon.com/pricing
- https://supabase.com/pricing
- https://supabase.com/docs/guides/database/migrating-to-pg-partman.md
- https://www.tigerdata.com/learn/pg_partman-vs-hypertables-for-postgres-partitioning
- https://orm.drizzle.team/docs/rls
- https://zomer.vercel.app/blog/postgresql-rls-drizzle-multi-tenant-security
- https://github.com/timgit/pg-boss
- https://www.inngest.com/pricing
- https://trigger.dev/pricing
- https://upstash.com/pricing/redis
- https://www.devtoolreviews.com/reviews/temporal-vs-inngest-vs-trigger-dev-vs-bullmq-2026
- https://www.pkgpulse.com/guides/better-auth-vs-lucia-vs-nextauth-2026
- https://www.better-auth.com/docs/plugins/generic-oauth
- https://centre-borelli.github.io/ruptures-docs/

Email / PDF / observability / support / billing
- https://devtoolpicks.com/blog/resend-vs-postmark-vs-mailgun-solo-developers-2026
- https://dev.to/iurii_rogulia/pdf-generation-on-the-server-puppeteer-vs-react-pdfrenderer-a-production-comparison-44cg
- https://braindetox.kr/en/posts/papermake_typst_pdf_server_2026.html
- https://sentry.io/pricing/
- https://axiom.co/pricing
- https://betterstack.com/pricing
- https://grafana.com/pricing/
- https://posthog.com/pricing
- https://www.eesel.ai/blog/crisp-pricing
- https://dodopayments.com/blogs/paddle-vs-lemon-squeezy/
- https://www.paddle.com/help/start/account-verification/which-countries-are-supported-by-paddle
- https://www.paddle.com/billing/pakistan
- https://shopify.dev/docs/apps/launch/distribution/revenue-share.md
- https://hookdeck.com/webhooks/platforms/shopify-webhooks-best-practices-revised-and-extended

Hosting
- https://vercel.com/pricing
- https://railway.com/pricing
- https://docs.fly.io/about/pricing
- https://www.hetzner.com/cloud/
- https://www.bitdoze.com/hetzner-cloud-cost-optimized-plans/
- https://wz-it.com/en/blog/self-hosted-paas-comparison-coolify-dokploy-caprover/
- https://oneuptime.com/blog/post/2026-01-30-dependency-scanning-integration/view
- https://turborepo.dev/docs/guides/tools/python

Agent workflow
- https://anthropic.com/engineering/effective-harnesses-for-long-running-agents
- https://anthropic.com/engineering/managed-agents
- https://www.anthropic.com/engineering/claude-code-best-practices
- https://code.claude.com/docs/en/hooks
- https://code.claude.com/docs/en/sub-agents
- https://code.claude.com/docs/en/sandboxing
- https://code.claude.com/docs/en/github-actions
- https://github.com/github/spec-kit
- https://docs.plannotator.ai/compare/github-spec-kit-vs-kiro-specs
- https://www.geocod.io/code-and-coordinates/2026-01-27-ralph-loops
- https://www.implicator.ai/anthropic-turned-claude-code-into-an-unattended-agent-runtime-this-spring/
- https://addyosmani.com/blog/claude-code-agent-teams/
- https://dupple.com/learn/best-mcp-servers-claude-code
- https://www.warp.dev/articles/metrics-that-prove-ai-coding-agents-are-working

---

## Notes for the main session
- Nothing in this report came from the user's memory store; all facts are from the fetched sources above or marked as estimates.
- Items worth asking the user to confirm/decide: (1) willingness to run one Hetzner VPS (Coolify) alongside Vercel/Neon at v1; (2) Paddle account verification from Pakistan (apply early; it can take documents); (3) whether to request Pinterest's written OK on storing per-user analytics metrics beyond 90 days before building the long-retention features.
- Unverified items I flagged: Vercel function max duration, AWS KMS current pricing, Neon's TimescaleDB extension availability, Plain's pricing, `GET /v5/user_account/websites` response fields.
