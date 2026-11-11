# PinInova — From Repo to Production: Deployment Plan

Copy of the Claude doc https://claude.ai/artifact/72qL45x2hTxGuUJ6mQBsvk (as of 9 Nov 2026), kept in the repo so
coding agents can read it. The doc is the editable original; update both if the plan changes.

## Where things stand

PinInova can realistically be live for paying customers in **mid-to-late January 2027**. The code is done and
tested against a mock Pinterest; what remains is mostly waiting on outside approvals, plus about a week of
deployment work.

- **Done:** every v0–v1 feature, 200+ automated tests, a security review with all serious findings fixed. The repo
  is on GitHub at `muhammadazhar22/PinInova`.
- **Mock-only today:** Pinterest, GA4, Shopify and Paddle billing. Nothing has touched a real service yet.
- **Critical path:** Pinterest Standard access. Its demo video must show a *live* deployed app doing a real OAuth
  connect, so staging has to be online first. Reviews have no published timeline; community reports run from one
  to several weeks, with repeat rejections common.
- **Runs in parallel:** Paddle verification and domain review, which need a public site with pricing, terms,
  refund and privacy pages.

| Workstream | Planned dates |
| --- | --- |
| GitHub repo + CI green | Nov 9 – Nov 11 |
| Domain, Pinterest app, Paddle sign-ups | Nov 9 – Nov 13 |
| Deploy code + staging online | Nov 12 – Nov 23 |
| Live smoke test + demo video | Nov 23 – Nov 27 |
| Pinterest Standard review (estimate) | Nov 27 – Jan 1 |
| Paddle verification + domain review | Nov 16 – Dec 4 |
| Beta on no-API features | Nov 30 – Jan 3 |
| Beta with real accounts | Jan 4 – Jan 17 |
| Production launch | Jan 19, 2027 |

If Pinterest's review runs past early January, only the last two rows move.

### Status on 11 Nov 2026

- Code: Step 3's list is mostly merged (ticked below). Open: `/pricing` (SPEC-080), Paddle checkout (SPEC-081), backups (SPEC-074).
- Found and fixed on 11 Nov while running the app locally on Windows/WSL: Windows reserved ports and IPv6 for the mock
  (SPEC-078), report PDF layout (SPEC-023), link checks not flagging re-authorization on a 401 (SPEC-020), reconnect
  blocked at the plan limit (SPEC-001), new-Pin collapse not reported (SPEC-079).
- Tracked Pins: owner chose to deliver Pro/Agency's 1,000 (`TRACKED_PINS_CAP` default raised to 1,000, SPEC-080).
- Owner items not started yet (Step 2): domain, Pinterest developer app, Paddle, Resend, hosting accounts. Drafts for
  the Pinterest submission, the agency DPA and the beta are in `docs/launch/`.

## Step 1 — Code on GitHub (done 9 Nov 2026)

Pushed to `main` with full history. Remaining repo settings for the owner:

- [ ] Actions: confirm the first CI run is green (web, analytics, e2e, browser jobs); fix anything red.
- [ ] Branch protection on `main`: require a pull request and passing CI; block force-pushes.
- [ ] Security: Dependabot alerts, secret scanning, push protection. `.env*` files are ignored.
- [ ] Environments: `staging` and `production`; `production` has the owner as required reviewer.
- [ ] Never commit `.env.local`, KEKs or Pinterest secrets. Pinterest revokes tokens that leak on GitHub.

## Step 2 — Start the long waits (owner, days 1–3)

| Task | What to do | Gates |
| --- | --- | --- |
| Domain + email | Buy a domain (e.g. Cloudflare Registrar); set up `support@` and `noreply@`. | Paddle review, Pinterest redirect URI, Resend |
| Pinterest developer app | Business account → developers.pinterest.com → My apps → Connect app. Read-only scopes `user_accounts:read`, `pins:read`, `boards:read`. Redirect URI `https://staging.<domain>/api/pinterest/callback`. | Trial access → Step 4 |
| Paddle account | Sign up, complete seller verification; build against the sandbox meanwhile. | Real payments |
| Resend | Add the domain, publish SPF/DKIM records. | Alert and invite e-mails |
| Legal pages | Privacy, terms, refund policy (14–90 days), agency DPA. Terms must name Paddle as merchant of record. | Paddle and Pinterest reviews |
| Pinterest questions (optional) | Send the drafted questions to developer support; answers update `ASSUMPTIONS.md`. | Nothing |

- Standard-access rejections most often cite a demo that does not show the authentication flow or a live Pinterest
  integration (https://developers.pinterest.com/docs/key-concepts/access-tiers/). Mock data is not enough.
- Paddle reviews the live public site; login walls and missing public pricing are the most common domain-review
  failures (https://developer.paddle.com/partners/embed-billing/seller-go-live/prepare-for-go-live).
- Stripe is not available to Pakistani sellers; Paddle is the plan, Lemon Squeezy the fallback.

## Step 3 — Put staging online (week 1–2)

Run web, worker, analytics and Chrome together on **one Hetzner VPS (Ashburn) with Docker Compose and Caddy**, with
**Neon** Postgres. This departs from PLAN.md's Vercel web tier because report PDFs render inside the web process
with Chrome (Vercel functions cannot run it) and the analytics service has no authentication yet, so it stays on a
private network. Vercel is possible later after those two changes.

| Piece | Where | Notes |
| --- | --- | --- |
| Web + worker + analytics + Chrome | Hetzner VPS, Docker Compose | Caddy terminates HTTPS for `staging.<domain>`; analytics only on the internal network |
| Postgres 16 | Neon, US-East | Create `pinpulse_app`; worker uses the **unpooled** connection string (pg-boss) |
| DNS + TLS | Cloudflare DNS, Caddy certificates | `staging.` now, apex later |
| E-mail | Resend | `EMAIL_TRANSPORT=resend` |
| Errors, uptime | Sentry, Better Stack | Uptime checks on `/api/health` |

Owner checklist (accounts, DNS, server, every secret and where it goes): `docs/runbooks/staging-setup.md`; server
`.env` template: `infra/staging.env.example`; deploy and rollback: `docs/runbooks/deploy-and-rollback.md`.

Code to write before deploying (one PR each):

- [x] Dockerfile for web + worker (Chrome included) and `docker-compose.prod.yml` with Caddy. (#2, SPEC-070)
- [ ] Public `/pricing`, `/privacy`, `/terms`, `/refunds` pages. Privacy/terms/refunds done (#5, SPEC-071); `/pricing` in review (SPEC-080). The legal pages show "[to be set: …]" until the owner fills `LEGAL_*`, `SUPPORT_EMAIL` and `REFUND_WINDOW_DAYS`.
- [ ] Paddle checkout (sandbox first): product/price IDs, checkout button, a new `paddle_live` billing mode. Webhook handler and simulated checkout exist; real checkout in progress (SPEC-081). Needs the owner's Paddle sandbox account to test end to end.
- [x] Sentry and OpenTelemetry; a worker heartbeat on the health endpoint. (#4, SPEC-072)
- [x] Deploy workflow: on merge to `main`, build images, migrate with the owner role, restart over SSH. (#6, SPEC-073; off until the repo variable `STAGING_DEPLOY_ENABLED=true`)
- [ ] Nightly `pg_dump` to Cloudflare R2 plus a restore script. Draft #8 (SPEC-074) was on hold; resumed 11 Nov 2026 at the owner's request.
- [x] Shared-secret auth on the analytics service. (#3, SPEC-075)
- [x] `apps/web/scripts/smoke-live.ts` checking the five guessed Pinterest contract details (docs/INTEGRATIONS.md; runbook `docs/runbooks/live-smoke-test.md`). (#7, SPEC-076)

Secrets: `BETTER_AUTH_SECRET` and `TOKEN_KEK_V1` (`openssl rand -base64 32`; keep a sealed offline copy of the KEK),
`DATABASE_URL` (app role), `DATABASE_OWNER_URL` (migrations only), Pinterest app ID/secret, Paddle sandbox key and
webhook secret, Resend key, Sentry DSN. Staging settings: `PINTEREST_MODE=mock` at first,
`BILLING_MODE=paddle_sandbox`, `TRUST_PROXY=true`; `INTEGRITY_ALLOW_PRIVATE_HOSTS=true` only while in mock mode.

**Done when:** `https://staging.<domain>` serves the app, the mock browser test passes against it, nightly jobs run,
and a backup restores into a fresh Neon branch.

## Step 4 — First real Pinterest connection and Standard-access application (week 2–3)

1. Switch staging to `PINTEREST_MODE=live` with the real app ID/secret. The app refuses live mode with mock
   credentials, simulated billing or private-host fetching.
2. Connect the owner's own business account through the real consent screen; confirm read-only scopes.
3. Run `apps/web/scripts/smoke-live.ts` (docs/runbooks/live-smoke-test.md); fix any contract differences; re-run the browser test on staging.
4. Check assumption PA-09 (can a Trial app read real organic analytics for its own account?) and record the answer.
5. Record a 3–5 minute demo: sign up → Connect Pinterest → real consent screen → sync and real data → report →
   disconnect.
6. Submit: My apps → Upgrade. Update the app description and privacy URL first.
7. No answer after 14 days: polite status post in the Pinterest Business Community with the app ID. Rejected:
   fix, re-record, resubmit within a week. Two refusals is a stop-and-rethink (kill criteria).

## Step 5 — Private beta (from week 3; real connections once Standard access lands)

Until Standard access, beta users use the no-API features: Drop Check, CSV import, pre-flight, weather.

1. Recruit 10–15 VAs; free during beta, founder discount after.
2. 20-minute onboarding call each; note every hesitation.
3. Label incidents (useful / not useful); target 50 labels; tune thresholds with the `detector-loop` skill.
4. Weekly review of alert precision, connect success, time to first insight, top three complaints → issues and PRs.
5. Paddle sandbox checkout on for beta users in beta week 2.

| Measure | Target before launch |
| --- | --- |
| Alert precision on labelled incidents | ≥ 80% |
| Connect → first diagnosis | under 10 minutes |
| Nightly sync success | ≥ 98% of planned accounts |
| Beta users who would pay | at least 8 of 15 |

## Step 6 — Production launch (target mid-to-late January 2027)

Separate VPS, Neon project, KEK and secrets; staging data never moves to production.

- [ ] Pinterest Standard access granted; app description and privacy URL on the production domain.
- [ ] Paddle verified, production domain approved, live products/prices, live webhook secret.
- [ ] `PINTEREST_MODE=live`, `BILLING_MODE=paddle_live`, fresh `TOKEN_KEK_V1` and `BETTER_AUTH_SECRET`.
- [ ] Migrations with the owner role; the app connects only as `pinpulse_app`.
- [ ] Backups: Neon PITR, nightly dump to R2, one restore drill with row counts compared.
- [ ] Monitoring: Sentry to phone, uptime on web and worker, alert when nightly sync falls below 90%.
- [ ] Purge and retention verified on production (disconnect a test account; nightly assertion shows zero rows).
- [ ] Legal pages live; support e-mail answered; deletion-certification process written (Pinterest may ask within 10 business days).
- [ ] Runbooks in `docs/runbooks/`: Pinterest outage, token refresh failures, KEK rotation, database restore.
- [ ] Integration register: Pinterest moves to "live" only after a week of clean production syncs.

Release = tagged image (`v2027.01.x`); rollback = deploy the previous tag; migrations are additive only.

## After launch: first 90 days

| Watch | Healthy | Act when |
| --- | --- | --- |
| Nightly sync success | ≥ 98% | below 90% on any night |
| Alert precision (labelled) | ≥ 80% | below 70% for two weeks |
| Paying workspaces | 30 by week 20 of the plan | fewer: stop and rethink |
| Infra bill | under about $75/month to 100 accounts | Neon usage above $150: self-host sync writes |

Weekly releases (detector changes in shadow first); monthly re-read of Pinterest's terms; next features from
PLAN.md months 5–12.
