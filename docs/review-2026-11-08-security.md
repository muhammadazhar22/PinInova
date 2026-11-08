# Security and privacy review — 2026-11-08

An independent reviewer (who had not written the code) audited `apps/web` for tenant isolation, consent, encryption,
deletion, Pinterest-access rules, SSRF, XSS, CSRF and open redirects. Every finding below was fixed in the same
change set and has a regression test unless marked otherwise. Migration: `db/migrations/0007_security_review.sql`.
Tests: `src/modules/privacy/review-fixes.test.ts`, `src/modules/integrity/fetcher.test.ts`.

| # | Severity | Finding | Fix |
|---|---|---|---|
| 1 | High | OAuth `state` was not bound to the browser or user: an attacker could start a connect, send the Pinterest authorize URL to a victim, and receive the victim's account in their own workspace (skipping consent text, consent link and revoke link). | `startConnect` returns a nonce; the connect and consent-start routes set it as an httpOnly cookie scoped to the callback; `oauth_state.nonce_hash` must match; the owner flow must also finish as the same signed-in user. Error page shows fixed messages by reason code. |
| 2 | High | SSRF guard bypassable with IPv6 literals (`[::1]`, `::ffff:7f00:1`, NAT64, 6to4, site-local). | Allow-list with `ipaddr.js`: only global unicast passes; IPv4-mapped judged as IPv4; IPv4-compatible refused; brackets stripped before the literal check; the socket's actual remote address is re-checked on `connect`. |
| 3 | High | Better Auth org deletion cascaded around PinPulse's purge and left partitioned metrics behind. | `disableOrganizationDeletion: true` (erasure goes through disconnect → purge); metrics tables now have `ON DELETE CASCADE` FKs to the connection; orphans removed by the migration. |
| 4 | Medium | A long sync/check/analysis could write rows after a purge (race). | `lockConnection()` (FOR SHARE on the connection row, status checked) at the start of every write transaction; disconnect/purge take the conflicting lock. |
| 5 | Medium | Purge missed `observed_signal`, alert e-mails and the `pinterest:<username>` audit actor. | Both tables purged and counted by the nightly assertion; alert e-mails carry `connection_id`; audit actor is now `consent_link:<id>`. |
| 6 | Medium | Erasure's audit anonymisation silently updated 0 rows (RLS) and its confirmation e-mail was queued forever. | `system_anonymise_actor()` SECURITY DEFINER; confirmation sent directly and never stored; queued mail to the address deleted. |
| 7 | Medium | Simulated billing and the dev webhook secret were accepted in production. | Production guard refuses `BILLING_MODE=simulated` with `PINTEREST_MODE=live` and a dev Paddle secret with real billing; the webhook route 404s in simulated mode. |
| 8 | Medium | Client viewers' transactions carried the agency's `app.org_id`. | `asUser` passes no org context for `client_viewer`. |
| 9 | Medium (plausible) | Viewer access was granted to whoever had registered the client's e-mail. | E-mailed, single-use, 14-day invitation (`viewer_invite`); access is granted only to the signed-in user who opens the link. |
| 10 | Low | Several actions accepted a `connection_id` from another tenant. | `lockConnection` proves the connection is in the current workspace (RLS) in CSV import, observed signals, GA4 leak, Shopify tokens and orders. |
| 11 | Low | Client viewers could change alert feedback. | `manage` required. |
| 12 | Low | Second weather report per day failed with an RLS error; limiter trusted spoofable `X-Forwarded-For` and grew without bound; reporter identities were free. | SECURITY DEFINER upsert; `TRUST_PROXY` gates XFF (right-most entry only); bounded map; new reporter identities capped at 3 per client per day. |
| 13 | Low | Retention skipped several derived tables. | Retention now covers issues, observed signals, leak results, order attribution, stale Pin metadata, e-mail (30 days), expired consent links and invites. |
| 14 | Low | `startsWith("/")` accepted `//evil.com`; error page echoed arbitrary text. | `safeRedirectPath` on store and use; reason codes only. |
| 15 | Low (plausible) | Rate gates live in process memory. | Not changed: syncs are singleton per connection in pg-boss, so one process owns a connection's gate at a time. Documented in `docs/INTEGRATIONS.md`; a shared limiter is needed before running per-connection work outside the sync job. |

Areas the reviewer found sound: report XSS (escaping + `default-src 'none'`, offline PDF rendering), share/consent/revoke
token handling, envelope encryption with AAD, Paddle signature verification, read-only scope enforcement and mock
labelling, SECURITY DEFINER functions returning identifiers only, CSRF on server actions and token-gated routes.
