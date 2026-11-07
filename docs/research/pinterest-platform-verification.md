# PinPulse — Pinterest platform-integration verification report (7 Nov 2026)

Primary sources only unless marked [secondary] or [unverified]. Endpoint facts from the official OpenAPI spec (v5.28.0) at https://raw.githubusercontent.com/pinterest/api-description/main/v5/openapi.json. Quoted fragments verbatim.

## 1. API v5

- Version 5.28.0; base `https://api.pinterest.com/v5`.
- OAuth 2.0: authorize at `https://www.pinterest.com/oauth/`; token endpoint `/v5/oauth/token` with HTTP Basic; sandbox via "-sandbox" in path. Access token `expires_in: 2592000` (30 days). Refresh: "Pinterest only supports the continuous refresh token (60-day expiration, refreshable indefinitely)"; automatic for apps created on/after 25 Sep 2025; "Repeat these steps before 60 days". Grant types: authorization_code, client_credentials (own account; 2FA required), refresh_token. PKCE not mentioned.
- Scopes: `user_accounts:read`, `pins:read` (+`read_secret`), `boards:read` (+`read_secret`), `ads:read`, plus write/billing/biz_access/catalogs.

| Endpoint | Scopes | Notes |
|---|---|---|
| `GET /user_account/analytics` | user_accounts:read | start_date "Cannot be more than 90 days back from today"; end_date ≤ 90 days past start; filters `from_claimed_content`, `pin_format`, `app_types`, `content_type` {ALL, PAID, ORGANIC}, `source` {ALL, YOUR_PINS, OTHER_PINS}, `metric_types` {ENGAGEMENT, ENGAGEMENT_RATE, IMPRESSION, OUTBOUND_CLICK, OUTBOUND_CLICK_RATE, PIN_CLICK, PIN_CLICK_RATE, SAVE, SAVE_RATE}, `split_field` {NO_SPLIT, APP_TYPE, OWNED_CONTENT, SOURCE, PIN_FORMAT}; returns `daily_metrics[]` + `summary_metrics` |
| `GET /user_account/analytics/top_pins` | pins:read, user_accounts:read | top 50 max; `sort_by`; `created_in_last_n_days` [30]; `date_availability{is_realtime, latest_available_timestamp}`; also `top_video_pins` |
| `GET /pins/{pin_id}/analytics` | boards:read, pins:read | same 90-day rules; metric_types required; `split_field` {NO_SPLIT, APP_TYPE}; lifetime metrics for Pins created on/after 2023-03-20 |
| `GET /pins/analytics` (bulk) | boards:read, pins:read | "currently in beta and not available to all apps"; max 100 pins per request |
| Board analytics | — | No endpoint; aggregate from Pin analytics |
| `GET /pins` | pins:read | `pin_metrics=true` returns 90d and lifetime metrics inline; `pin_filter`; `domains[]` (max 100); `page_size` max 250 |
| `GET /user_account/websites` | user_accounts:read | `website`, `status`, `verified_at` ("sometimes missing"); POST verifies (FILENAME, METATAG, DNSTXT) |
| `GET /search/partner/pins` | boards:read, pins:read | Beta; "Get the top 10 Pins by a given search term" |
| `PATCH /pins/{pin_id}` | pins:write | Beta; editable `ai_disclosures`, `alt_text`, `board_id`, `description`, `link`, `title` |
| AI disclosure | — | `ai_disclosures.values[]` enum AI_MODIFIED, SYNTHETIC_PERFORMER |

Webhooks: lead-ads subscriptions only; no organic webhooks. Bulk: ads only (+ beta pins/analytics). Data lag: ~48 h observed for organic (community, 8 Jun 2026, https://community.pinterest.biz/t/v5-user-account-analytics-returning-delayed-data-48-hours-old-for-organic-analytics/46517); not officially documented. Rate limits (https://developers.pinterest.com/docs/reference/rate-limits/): Trial "1000 requests per day for all API requests"; Standard "100 requests per second per user per app"; `org_analytics` Standard 60/min/user/app; `org_read` 1,000/min; `org_write` 100/min; headers `x-ratelimit-limit/remaining/reset`.

## 2. Access tiers, review, partners

Trial vs Standard (https://developers.pinterest.com/docs/key-concepts/access-tiers/): Trial entities visible only to creator as Sandbox; upgrade needs Developer Guidelines compliance and "a video recording of your app completing an action using the Pinterest API" (OAuth flow even for solo use); "allow a few days"; rejections: inaccurate privacy policy, vague description, video missing auth flow, credential/cookie collection. Known issue (25 Aug 2026, updated Oct 2026): approval backlog; threads report 14–30+ day waits and unexplained denials (https://community.pinterest.biz/t/known-issue-support-for-trial-access-pending-or-denied-access/50249). `PINNER_DATA_ACCESS_DENIED` (staff post 1 Oct 2026): apps registered on/after 14 Sep 2026 get 403 reading boards/Pins not owned by the authorizing account; own content needs no extra approval (https://community.pinterest.biz/t/understanding-the-pinner-data-access-denied-access-error/51738). Pinterest Partners: Organic presence specialty "at capacity"; applications open only for Shopping.

## 3. Developer Terms & Guidelines (Last Updated August 2026; https://developers.pinterest.com/terms/)

| Topic | Clause |
|---|---|
| Storage | Guidelines: "you may not store any information accessed through any Pinterest Materials including the API." / "Instead, call the API each time you need to access information." Terms §4.1(a): exception for "campaign analytics information accessed via the Materials about your account, or about another account for which the account holder has expressly granted you access" |
| Combining | "Don't combine someone's account information with information from other people's accounts" |
| Benchmarking | No "platform insights, benchmarking, or competitor research features unless you have explicit written authorization from Pinterest (email is sufficient)" |
| Scraping | §2.7(xiii), §4.3(d): no "automated means or form of scraping or data extraction" |
| AI training | §2.7(xii): no training/fine-tuning without written consent |
| PII | §4.3(c): "You will not join any Pinterest Data with personally identifiable information" |
| Deletion | §4.4: delete "in no event later than thirty (30) days" after revoke/churn/account deletion; certification within 10 business days on request; EEA/UK breach notice within 72 hours |
| Review | §2.3: submit "for review and approval prior to distribution"; material changes need re-review |
| Actions | No actions "without their specific knowledge and consent"; no features that "automatically initiate actions" |
| Intermediary tools | "Model Context Protocol (MCP) servers, wrappers, plugins, middleware, agents" covered |
| Usage limits | §2.6: may "throttle, suspend, or permanently revoke your access… without prior notice" |
| Sharing | "Don't share or sell information from our API with a third party" |

## 4. Community Guidelines update, effective 12 Nov 2026

Preview (https://policy.pinterest.com/community-guidelines-preview): repetitive rule now "create, save, or distribute"; new "Scams, deceptive goods, and practices" (engagement manipulation "through automated, paid, or incentivized means"; synthetic media misrepresenting products); catch-all "dishonest tactics to attempt to improperly influence distribution, clicks, or other metrics"; "redirect existing Pins" line dropped (no-surprises rule remains); no creator AI-labelling requirement; "affiliate" absent. [secondary] Panstag 13 Oct 2026 analysis.

## 5. Native Analytics, export, Conversion insights, UTMs

Analytics UI: "past year and a half" plus "real-time estimates from the last 48 hours"; CSV export of selected filters. Conversion insights: Beta; ~1.5 years; no 60-day window. Organic auto-UTM: "UTM source as 'Pinterest' and UTM medium as 'Organic' to all destination URLs"; opt-out in Business settings. Ads auto-UTM from 15 Sep 2026 (community, 7 Oct 2026); exact values [unverified].

## 6. Enforcement

Current (Apr 2025) and preview (12 Nov 2026): Deactivation; Limited distribution ("won't be featured in recommendation or discovery surfaces"); "shown less often or less prominently" without violation; appeals capped "for a period of up to one year" and per decision.

## 7. Visit-site button and Pinterestbot

Pin links article (create.pinterest.com, 9 May 2025): button needs "a clear content match"; moved to "…" when quality cannot be determined (404s, mismatch, slow load, unsafe); "under four seconds"; claimed-site requirement [unverified; creator claims only]. Pinterestbot: UAs `Pinterest/0.2 (+https://www.pinterest.com/bot.html)` and `Mozilla/5.0 (compatible; Pinterestbot/1.0; +https://www.pinterest.com/bot.html)`; US IPs 54.236.1.001–255; verify by reverse DNS; robots.txt on main domain only; crawl-delay honored up to 1; "Large crawl delays impact the distribution and recommendation of your content".

## 8. Engineering blog signals (2024–2026)

Multi-objective home feed ranking (Apr 2026); Pinner-survey quality model (Dec 2025); real-time violative-content radar (Dec 2025; signals impressions, clicks, hides, reports); misinformation/hate/self-harm ML (image-signature grouping, board scores); GenAI labels (metadata + classifiers, Apr 2025) and tuner (Oct–Dec 2025). No link-quality scoring post found.

## 9. Third-party constraints

GA4 Data API: 200,000 core tokens/property/day, 40,000/hour, 10 concurrent; Direct = source "(direct)" and medium "(not set)"/"(none)"; Organic Social precedes Organic Search in channel definitions. Shopify: `CustomerJourneySummary` (firstVisit, lastVisit, moments, ready) and `CustomerVisit.utmParameters`; orders are protected customer data (Level 1/2); App Store requires Shopify Billing, screencast, privacy policy; revenue share 0% to $1M then 15%, 2.9% processing; Hyperwallet payouts, $25 minimum, Pakistan [unverified]. Paddle: Pakistan not on unsupported list; 5% + $0.50; payout details for PK [unverified]. Lemon Squeezy: Pakistan listed for bank payouts; 5% + $0.50 + 1.5% international + 0.5% subscription + 1% non-US payout.

## 10. Market stats (Q3 2026)

Revenue $1,174M (+12% YoY); 661M MAU (+10%); net income $22M; Adj. EBITDA $339M; Q4 guide $1,425–1,475M; "searches, boards created, and outbound clicks all grew faster than users in Q3" (UCAN).

## Hard constraints table

| Constraint | Consequence |
|---|---|
| 90-day lookback and window | Daily snapshots; CSV backfill |
| Storage clause with analytics exception | Store metrics only for consenting account; written consent |
| No benchmarking without authorization | Own-history comparisons only |
| No combining users' data | Per-tenant isolation |
| Delete ≤ 30 days after revoke/churn | Automated purge + attestation |
| No automated actions | One-Pin, one-confirmation fixes |
| PATCH pins beta; bulk analytics beta | Diagnose-only launch; request betas |
| No board analytics; no organic webhooks | Aggregate from Pins; poll |
| Trial 1,000 req/day sandbox | Fixture recording only |
| Standard review video; weeks-long backlog | +4–8 weeks |
| Post-14-Sep-2026 apps: 403 on non-owned content | No competitor-Pin features |
| Auto-UTMs | Detect opt-out and custom UTMs |
| Pinterestbot rules | Site-health checks |
| 12 Nov guideline changes | Update rules copy |
| Appeal caps | Prioritised appeals |
| GA4 quotas; Shopify protected data | Daily cached pulls; Level 1 only |
| Stripe unavailable | Paddle or Lemon Squeezy |

## Open questions for Pinterest developer support

1. Written consent to store daily snapshots of a connected account's organic analytics under Terms §4.1(a).
2. Whether comparing to Pinterest-published best-practice thresholds is "benchmarking"; conditions for anonymised cross-tenant authorization.
3. Official organic analytics lag and `date_availability.is_realtime` semantics.
4. Beta access to `GET /pins/analytics` and `PATCH /pins/{id}`.
5. Rate-limit category of analytics endpoints; higher per-user limits for agencies.
6. Standard-access review SLA and denial reasons.
7. Whether agency Business Access satisfies "expressly granted".
8. Exact ad auto-UTM values and organic auto-UTM start date; API field for the "Apply URL parameters" toggle.
9. Any field exposing limited-distribution state or Visit-site eligibility.
10. MCP/agent layer acceptability under the Intermediary Tools clause.
11. GenAI Acceptable Use obligations mapping to `ai_disclosures`.

Not verified: exact ad auto-UTM values; GenAI Acceptable Use Guidelines contents; Pinterest's own claimed-site requirement for Visit-site; Google's social-sites list; Paddle and Hyperwallet payouts for Pakistan; year of v5.28.0 release.

Sources: OpenAPI spec; https://developers.pinterest.com/docs/getting-started/authentication-and-scopes/ ; https://developers.pinterest.com/docs/getting-started/scopes/ ; https://developers.pinterest.com/docs/reference/rate-limits/ ; https://developers.pinterest.com/docs/key-concepts/access-tiers/ ; https://developers.pinterest.com/docs/getting-started/using-beta-and-restricted-features/ ; https://developers.pinterest.com/terms/ ; https://policy.pinterest.com/en/developer-guidelines ; https://policy.pinterest.com/en/community-guidelines ; https://policy.pinterest.com/community-guidelines-preview ; https://policy.pinterest.com/en/enforcement ; https://policy.pinterest.com/en/enforcement-preview ; https://help.pinterest.com/en/business/article/pinterest-analytics ; https://help.pinterest.com/en/business/article/conversion-insights ; https://help.pinterest.com/en/business/article/url-parameters-for-organic-content ; https://help.pinterest.com/en/business/article/pinterestbot ; https://create.pinterest.com/en-ca/blog/pin-link-update/ ; https://business.pinterest.com/pinterest-partners/ ; https://community.pinterest.biz/t/automatic-utm-parameters-for-eligible-ad-destination-urls/51935 ; https://developers.google.com/analytics/devguides/reporting/data/v1/quotas ; https://support.google.com/analytics/answer/9756891 ; https://shopify.dev/docs/apps/launch/app-requirements-checklist ; https://shopify.dev/docs/apps/launch/distribution/revenue-share ; https://www.paddle.com/help/start/account-verification/which-countries-are-supported-by-paddle ; https://docs.lemonsqueezy.com/help/getting-started/supported-countries ; https://www.sec.gov/Archives/edgar/data/0001506293/000150629326000151/q3-26xpressrelease.htm
