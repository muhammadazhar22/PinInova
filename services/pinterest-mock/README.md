# @pinpulse/pinterest-mock

> **THIS IS NOT PINTEREST. ALL DATA IS SYNTHETIC.**
> A local stand-in for Pinterest API v5, built so PinInova can run end to end before it has Standard API access.
> Every response has an `x-mock-pinterest` header (the sites server sends `x-mock-site`), the consent page title is
> "MOCK Pinterest — not the real Pinterest", and every account, Pin, board, image and metric is generated from `MOCK_SEED`.
> Passing tests here proves nothing about the live Pinterest API (see `docs/INTEGRATIONS.md`). UI and logs that use
> this server must say they are using mock data.

It copies the response shapes in `fixtures/pinterest/openapi-v5.28.0.json`. The tests check every endpoint's responses against
the spec's own schemas with ajv. The check is strict: a response fails if it has a field the spec does not define.
Where the spec says nothing, the behaviour below is a **mock assumption**, marked **[MA]**.

## Run

```bash
pnpm install --ignore-workspace     # inside services/pinterest-mock
pnpm start                          # API on :4010, mock websites on :4011
pnpm dev                            # same, with watch
pnpm test                           # vitest (57 tests)
pnpm typecheck
```

In-process, for other packages' tests:

```ts
import { createMockServer, createMockSites } from "@pinpulse/pinterest-mock"; // or a relative path to src/index.ts
const sites = await createMockSites({ port: 0 });
const api = await createMockServer({ port: 0, siteBase: sites.url, today: "2026-11-08", seed: 1 });
// api.url -> http://127.0.0.1:<port>; API base is `${api.url}/v5`, authorize URL is `${api.url}/oauth/`
await api.close(); await sites.close();
```

Each returns `Promise<{ url, port, close() }>`. `createMockSites` also has `requests()`. `createMockServer` takes extra
options for tests: `now: () => number` (a fake clock for code, token and rate-limit expiry), `redirectUris`, `apiBase` and `log`.

Web app config (`apps/web/src/env.ts`): `PINTEREST_MODE=mock`, `PINTEREST_API_BASE=http://127.0.0.1:4010/v5`,
`PINTEREST_OAUTH_BASE=http://127.0.0.1:4010/oauth/`, `PINTEREST_CLIENT_ID=mock-client-id`, `PINTEREST_CLIENT_SECRET=mock-client-secret`.

### Configuration (env; the same names work as camelCase options)

| Env | Default | Meaning |
|---|---|---|
| `MOCK_PORT` | 4010 | API port (0 = random) |
| `MOCK_SITE_PORT` | 4011 | mock websites port |
| `MOCK_HOST` | 127.0.0.1 | bind host |
| `MOCK_CLIENT_ID` / `MOCK_CLIENT_SECRET` | `mock-client-id` / `mock-client-secret` | the only valid app credentials |
| `MOCK_TODAY` | current UTC date (re-read on every request) | anchors all synthetic dates |
| `MOCK_RATE_ANALYTICS_PER_MIN` | 60 | `org_analytics` limit per token |
| `MOCK_RATE_READ_PER_MIN` | 1000 | `org_read` limit per token |
| `MOCK_FAULT_RATE` | 0 | probability (0..1) of an injected 500/503 |
| `MOCK_AUTO_CONSENT` | false | skip the consent page (user `mock_healthy`) |
| `MOCK_SEED` | 1 | dataset seed |
| `MOCK_SITE_BASE` | `http://127.0.0.1:${MOCK_SITE_PORT}` | base URL used in Pin links and websites |
| `MOCK_API_BASE` | listening URL | public base used in image URLs (set this for docker) |
| `MOCK_REDIRECT_URIS` | unset = any http(s) URI | comma-separated allow-list |
| `MOCK_SITE_SLOW_MS` | 5000 | delay for the slow path |
| `MOCK_LOG` | false | one stderr line per request |

## What it mirrors

### OAuth ([Pinterest docs](https://developers.pinterest.com/docs/getting-started/authentication-and-scopes/))

- `GET /oauth/?client_id&redirect_uri&response_type=code&scope&state` serves the consent page. You pick a mock account with a
  radio button, see the requested scopes, then click Allow or Deny. The form posts to `POST /oauth/consent`.
  - Allow: `302 redirect_uri?code=…&state=…`. Deny: `302 redirect_uri?error=access_denied&state=…`.
  - A wrong `client_id`, or a missing or invalid `redirect_uri`, gets a 400 HTML page; it does not redirect. A
    `response_type` other than `code` redirects with `error=unsupported_response_type`.
  - With `mock_user=<username>` in the query (or `MOCK_AUTO_CONSENT=true`, which uses `mock_healthy`), there is no page:
    you are redirected straight away. An unknown `mock_user` gets a 400. This is for automated tests.
  - Scopes are comma-separated and come back the same way in the token response's `scope`. Space-separated scopes are also accepted.
- `POST /v5/oauth/token` takes HTTP Basic auth (`client_id:client_secret`) and an `application/x-www-form-urlencoded` body.
  - `grant_type=authorization_code` needs `code` and `redirect_uri`. The `redirect_uri` must match the authorize call
    exactly. Codes work once and expire after 10 minutes.
  - `grant_type=refresh_token` returns a new access token **and a new refresh token** (continuous refresh, 60-day rolling
    window). The old refresh token stops working at once. **[MA]** Older access tokens stay valid until they expire.
  - Response (`OauthAccessToken`): `access_token` (`pina_MOCK_…`), `refresh_token` (`pinr_MOCK_…`), `response_type`
    (`authorization_code` | `refresh_token`), `token_type: "bearer"`, `expires_in: 2592000`,
    `refresh_token_expires_in: 5184000`, `refresh_token_expires_at` (epoch seconds), `scope`.
  - Errors use `Pinterest.Lib.Error` `{code, message}` **[MA codes]**: bad client credentials give 401 `code 2`. A bad,
    reused, expired or mismatched code or refresh token gives 400 `code 1`. An unknown `grant_type` or
    `client_credentials` (not mocked) gives 400 `code 1`.
- The token endpoint is rate limited as `org_read`, per `client_id`, as tagged in the spec's `x-ratelimit-category`.

### API (`/v5`, `Authorization: Bearer <access_token>`)

| Endpoint | Rate category (from spec) | Scopes enforced |
|---|---|---|
| `GET /v5/user_account` | org_read | user_accounts:read |
| `GET /v5/user_account/analytics` | org_analytics | user_accounts:read |
| `GET /v5/user_account/analytics/top_pins` | org_analytics | pins:read, user_accounts:read |
| `GET /v5/pins` | org_read | boards:read, pins:read |
| `GET /v5/pins/{pin_id}` | org_read | boards:read, pins:read |
| `GET /v5/pins/{pin_id}/analytics` | org_analytics | boards:read, pins:read |
| `GET /v5/boards` | org_read | boards:read |
| `GET /v5/user_account/websites` | org_read | user_accounts:read |

Errors (all `{code, message}`; message wording and numeric codes are **[MA]** unless noted):

- 401 `code 2`: the token is missing, unknown, expired (`…has expired`) or revoked (`…has been revoked`).
- 403 `code 3`: the token lacks a required scope **[MA]**.
- 403 for a Pin owned by a different mock account, from `GET /pins/{id}` and its analytics. The body is
  `{"code":403,"message":"PINNER_DATA_ACCESS_DENIED","detail":"Your application does not have access to read pinner data. Your application must be approved for pinner data access."}`.
  This copies the body in Pinterest's staff post of 1 Oct 2026 (`docs/research/pinterest-platform-verification.md`).
- 404 `code 50`: the Pin is not found.
- 400 `code 1`: a parameter is invalid.
- 400 for any request with `ad_account_id`. Business Access is not mocked **[MA]**.
- 404 for `/v5` routes that are not implemented.

**Analytics rules.** `start_date` and `end_date` are required (`YYYY-MM-DD`). `start_date` may not be more than 90 days before
MOCK_TODAY; exactly 90 days is allowed. `end_date` must be on or after `start_date` and no more than `start_date + 90`. Breaking
any of these gives a 400. Each enum parameter accepts only its spec values. `metric_types` takes comma-separated values (the
spec has `explode: false`) or a repeated parameter. If you leave it out, user-account analytics return all nine metrics. Pin
analytics require `metric_types`, accept `ALL` with `NO_SPLIT` only, and return 400 for `ALL` with `APP_TYPE`.
**[MA]** Days after MOCK_TODAY inside a valid window are left out of the response rather than rejected.

**Response keys by `split_field` [MA: the spec only says `additionalProperties`].**
`NO_SPLIT` uses `"all"`, as in Pinterest's published examples. Each other split uses the values of the matching filter
parameter's enum, minus that enum's "everything" value. Every group is always present, even when it is all zeros. The list is
exported as `SPLIT_KEYS`. Typed clients should treat the keys as `Record<string, AnalyticsMetricsResponse>`.

| split_field | keys |
|---|---|
| NO_SPLIT | `all` |
| APP_TYPE | `MOBILE`, `TABLET`, `WEB` |
| OWNED_CONTENT | `CLAIMED`, `OTHER` (whether the Pin's link domain is one of the account's verified websites) |
| SOURCE | `YOUR_PINS`, `OTHER_PINS` |
| PIN_FORMAT | `ORGANIC_IMAGE`, `ORGANIC_PRODUCT`, `ORGANIC_VIDEO` |

Pin analytics `split_field=APP_TYPE` gives `MOBILE`/`TABLET`/`WEB`; `NO_SPLIT` gives `all`.

Trimmed example, `GET /v5/user_account/analytics?start_date=2026-11-05&end_date=2026-11-08&metric_types=IMPRESSION,OUTBOUND_CLICK_RATE`:

```json
{"all":{"daily_metrics":[
  {"date":"2026-11-05","data_status":"READY","metrics":{"IMPRESSION":1258,"OUTBOUND_CLICK_RATE":0.007949}},
  {"date":"2026-11-07","data_status":"PROCESSING","metrics":{"IMPRESSION":1103,"OUTBOUND_CLICK_RATE":0.001813}},
  {"date":"2026-11-08","data_status":"PROCESSING","metrics":{"IMPRESSION":322,"OUTBOUND_CLICK_RATE":0}}],
  "summary_metrics":{"IMPRESSION":4050,"OUTBOUND_CLICK_RATE":0.004691}}}
```

**Filters.**

- `content_type=PAID` returns zeros, because mock accounts run no ads. `ORGANIC` is the same as `ALL`.
- `pin_format` values `ADS_*` return zeros.
- `source=OTHER_PINS` is a small separate series: other people's Pins of the account's claimed content, about 8% of
  impressions. It is zero when the account has no verified site.
- `from_claimed_content` filters on whether the Pin links to a verified website.
- `app_types` picks the per-device part of each count. The device split is deterministic, and the parts always add up to the total.

**Metrics.**

- `ENGAGEMENT` = SAVE + PIN_CLICK + OUTBOUND_CLICK **[MA]**.
- Each `*_RATE` is that metric divided by IMPRESSION. Rates are rounded to 6 decimal places, and are 0 when there are no impressions.
- In `summary_metrics`, counts are sums and rates are worked out again from those sums.
- Pin analytics also return `TOTAL_REACTIONS`, `TOTAL_COMMENTS`, `PROFILE_VISIT` and `USER_FOLLOW`, plus video metrics
  (video Pins only; 0 for others). These are derived from the base counts. `VIDEO_AVG_WATCH_TIME` is
  `VIDEO_V50_WATCH_TIME / VIDEO_START`, in ms.
- `lifetime_metrics` (`TOTAL_COMMENTS`, `TOTAL_REACTIONS`) is included only when those metrics are requested.

**Data lag [MA: no official lag is documented; ~48 h has been observed for organic data].**

- MOCK_TODAY−1 and MOCK_TODAY are included with `data_status: "PROCESSING"`. They hold about 70% and about 25% of
  each day's final numbers.
- Earlier days are `READY`.
- In Pin analytics, days before the Pin was created are `{"data_status":"BEFORE_PIN_CREATED","metrics":{}}`.
- MOCK_TODAY is included, not left out, so clients can test their handling of provisional days (`PROVISIONAL_DAYS=2` in the web env).

**top_pins.**

- `sort_by` is required. `num_of_pins` is 1–50 (default 10). `created_in_last_n_days` accepts only `30`. The same filters
  apply as for account analytics.
- Only your own Pins are ranked: `source=OTHER_PINS` gives an empty list.
- `metrics` holds the requested metric types plus `sort_by`. `data_status` has one entry per metric: `PROCESSING` if the
  window reaches into the last two days, otherwise `READY` **[MA]**.
- `date_availability` is `{ is_realtime: <window includes PROCESSING days>, latest_available_timestamp: <epoch ms of 23:59:59 UTC on MOCK_TODAY−2> }` **[MA]**.

**Pins.**

- `GET /v5/pins` lists newest first. `page_size` is 1–250 (default 25; above 250 gives a 400). Paging uses an opaque
  `bookmark` (`null` on the last page). A bad bookmark gives a 400.
- `domain` and `domains` match the **mock domain slug** (for example `domain=garden-notes`) or the sites host **[MA]**,
  because every mock domain shares one host.
- `creative_types` is supported.
- `pin_filter=exclude_native` and `pin_filter=has_been_promoted` return nothing, because every mock Pin is native and unpromoted.
- `pin_metrics=true` (on the list and on `GET /pins/{id}`) adds the keys from the spec's example:
  `{"90d":{"pin_click","impression","clickthrough"},"lifetime_metrics":{"pin_click","impression","clickthrough","reaction","comment"}}`.
  `clickthrough` = outbound clicks. Without it, `pin_metrics` is `null`.
- Timestamps are RFC 3339 with a `Z`, per the spec's `format: date-time` **[MA]**. Live Pinterest has been seen sending them
  without an offset, so clients should accept both. Pins created on MOCK_TODAY get a time between 00:00 and 00:59 UTC.

Pins list item (trimmed):

```json
{"id":"813902000000000320","created_at":"2026-11-08T00:40:05Z","link":"http://127.0.0.1:4011/cozy-kitchen/rustic-soup-recipe-p20319",
 "title":"Rustic Soup Recipe","description":"Rustic Soup Recipe. MOCK Pin with synthetic data for PinInova development.",
 "dominant_color":"#415F4C","alt_text":null,"creative_type":"REGULAR","board_id":"552102000000000001","board_section_id":null,
 "board_owner":{"username":"mock_platform_cliff"},"is_owner":true,"is_standard":true,"is_product":false,"has_been_promoted":false,
 "parent_pin_id":null,
 "media":{"media_type":"image","images":{"150x150":{"width":64,"height":64,"url":"http://127.0.0.1:4010/__img/813902000000000320.png"},
   "400x300":{…},"600x":{…},"1200x":{…}}},
 "pin_metrics":null}
```

Video Pins use `media_type: "video"`, with `cover_image_url`, `duration`, `width`, `height`, `video_url: null`,
`video_url_hls: null` and `images`. **[MA]** Every image size points at the same 64×64 PNG and reports its true size (64×64).

**Boards.** `GET /v5/boards` is paginated like the Pins list. All mock boards are `PUBLIC`, so `privacy=SECRET` or
`PROTECTED` returns nothing.

**Websites.** `GET /v5/user_account/websites` returns
`{items:[{website:"${MOCK_SITE_BASE}/<slug>", status:"verified"|"unverified", verified_at?}], bookmark}`.

- `verified_at` is left out when the site is unverified, and on one verified site (the spec says it is "sometimes missing").
- **[MA]** The status strings are a guess. **[MA]** `website` includes the scheme because it is built from `MOCK_SITE_BASE`;
  the spec describes it as "path or domain only".

### Rate limiting **[MA where noted]**

- There is one fixed 60-second window per (category, access token). The window starts with the first request in it **[MA]**.
- Limits: `org_analytics` = `MOCK_RATE_ANALYTICS_PER_MIN`, which covers user-account analytics, top_pins and Pin analytics.
  `org_read` = `MOCK_RATE_READ_PER_MIN`. The categories come from the spec's `x-ratelimit-category`.
- Every `/v5` response, including 401, 403, 429 and 5xx, sends three headers:
  - `x-ratelimit-limit`: a plain integer **[MA]**.
  - `x-ratelimit-remaining`.
  - `x-ratelimit-reset`: **whole seconds until the current window resets** (rounded up, at least 1) **[MA]**.
- Over the limit you get 429 `{"code":8,"message":"You have exceeded your rate limit. Try again later."}` **[MA code/message]**.
  It has no `Retry-After` header; use `x-ratelimit-reset`.
- Requests with an invalid token are counted in a bucket keyed by the token string they sent.
- The order of checks is: auth (401), then rate limit (429), then injected fault (500/503), then scope (403), then the handler.

### Fault injection

`MOCK_FAULT_RATE` (or `POST /__mock/fault`) injects errors on `/v5` API calls. The token endpoint is excluded.

- The faults are 500 `{code:500,…"(MOCK injected fault)"}` or 503 `{code:503,…}` with `retry-after: 1`.
- The fault sequence comes from a PRNG seeded by `MOCK_SEED`. The same seed and the same request order give the same faults.
  `POST /__mock/reset` restarts the sequence.
- Faulted requests still count against the rate limit.

### Images

`GET /__img/<pin_id>.png` (public, no auth) serves a deterministic 64×64 8-bit RGB PNG. It is made by a small encoder built on `node:zlib`.

- The pattern comes from the Pin's "image id". Duplicate Pins share an image id, so their files are byte-identical.
- A few duplicates are variants: exactly one pixel row is inverted (row 21–24), to exercise perceptual hashing.
- `/__img/account-<id>.png` is the profile image.

## Accounts and scenarios

All dates are relative to MOCK_TODAY.

- About 730 days of history are generated. The API exposes only 90-day windows; lifetime `pin_metrics` use the full history.
- Each account has 150–400 Pins. They are spread over 2 years, with posting ramping up to about 3–7 new Pins a week recently.
- Pin performance is heavy-tailed (Pareto): the top 10% of Pins carry more than half the impressions.
- Each account has 4–8 boards, 2–3 linked domains, and about 10% of Pins with no link.
- Account totals are weekly seasonal (Sunday high, Friday low) with day-level noise.
- **Every account-level number is the sum of the per-Pin series, plus the `OTHER_PINS` component.** The sum of Pin analytics
  therefore equals `source=YOUR_PINS` exactly, including device splits.
- Generating all accounts takes about 0.3–0.5 s and is cached per (seed, today).

| username | scenario | signature | domains (status) |
|---|---|---|---|
| `mock_healthy` | healthy | weekly seasonality, mild upward trend, no cliff | cozy-kitchen (v), garden-notes (v) |
| `mock_platform_cliff` | cause **D** | ~85% account-wide step drop starting MOCK_TODAY−25 across all Pin ages and domains; CTR unchanged | cozy-kitchen (v), garden-notes (v) |
| `mock_domain_block` | cause **A** | Pins linking to **deal-hub** fall ~95% from MOCK_TODAY−30; other domains and unlinked Pins unchanged. deal-hub's robots.txt disallows Pinterestbot, so integrity checks find a real, fixable cause | deal-hub (v), cozy-kitchen (v), garden-notes (unverified) |
| `mock_new_pins_zero` | cause **C** | Pins created in the last 21 days (created ≥ MOCK_TODAY−20) get 0–2 impressions/day; older Pins fine. 40-Pin burst; ~75% share one link URL on garden-notes and one image, including 4 one-row image variants | garden-notes (v), cozy-kitchen (unverified) |
| `mock_quality_drop` | cause **B** | impressions ×0.4 and outbound CTR ×0.5 from MOCK_TODAY−20; ~35% of broken-links Pins point at 404 `/old/` paths | broken-links (v), cozy-kitchen (v) |
| `mock_viral_fade` | cause **E** | one Pin (created MOCK_TODAY−35, peak MOCK_TODAY−30) has ~60% of 90-day impressions and decays exponentially (τ ≈ 11 days) | garden-notes (v), cozy-kitchen (v, no verified_at) |
| `mock_agency_client_1` | healthy growth | steady growth; links go through a 3-hop redirect chain | redirect-shop (v), cozy-kitchen (unverified) |
| `mock_agency_client_2` | mild decline | about −10% over 90 days; Crawl-delay: 10 site; some Pins on the 5 s slow path | crawl-delay-co (v), slow-blog (v), garden-notes (unverified) |

## Mock websites (`createMockSites`, default :4011)

Each "domain" is a path prefix, `${MOCK_SITE_BASE}/<slug>/…`. Its robots.txt is at `${MOCK_SITE_BASE}/<slug>/robots.txt`
**[MA: on the real web, robots.txt lives at the host root, so the integrity checker must map domain to slug in mock mode]**.

Page `<title>` (and `og:title`) is worked out from the last path segment: `easy-pasta-recipe-p10003` becomes "Easy Pasta
Recipe", which equals the Pin title. The sites server therefore needs no dataset.

| slug | behaviour |
|---|---|
| `cozy-kitchen` | normal 200 pages |
| `garden-notes` | normal 200 pages |
| `deal-hub` | robots.txt has `User-agent: Pinterestbot` / `Disallow: /` (also blocks the `Pinterest` UA); pages otherwise 200 |
| `redirect-shop` | `/<p>` 301 → `/r/1/<p>` 302 → `/r/2/<p>` 307 → `/final/<p>` 200 (3 hops; absolute `Location` built from the Host header) |
| `broken-links` | `/broken-links/old/…` returns 404; other paths 200 |
| `slow-blog` | `/slow-blog/slow/…` responds after 5 s (`slowDelayMs` / `MOCK_SITE_SLOW_MS`); other paths are fast |
| `crawl-delay-co` | robots.txt has `Crawl-delay: 10` |

Other endpoints:

- `GET /` lists the sites.
- `GET /__requests` returns `{mock:true, requests:[{at, method, path, slug, user_agent, status}]}`. It holds the last 5000
  requests; the control endpoints are not logged.
- `POST /__requests/reset` clears the log.

## Admin endpoints (mock only, not under `/v5`)

| Endpoint | Body | Effect |
|---|---|---|
| `POST /__mock/reset` | – | clear all codes, tokens, revocations and rate-limit windows; reset the fault rate to config; restart the fault RNG |
| `POST /__mock/expire-access-token` | `{"access_token":"…"}` | that token now gets 401 (expired); 404 if unknown |
| `POST /__mock/revoke` | `{"username":"mock_…"}` | simulates the user removing the app: all of that user's access and refresh tokens become invalid (401 / 400). The user can authorize again afterwards |
| `POST /__mock/fault` | `{"rate":0.2}` | set the fault rate (0..1) |
| `GET /__mock/state` | – | seed, today, rate config and live windows, fault stats, codes and tokens (first 14 characters of each token only), revocations |
| `GET /__mock/accounts` | – | accounts, scenarios, domains with site behaviour, and an authorize URL hint |

`GET /` on the API describes the server as a mock.

## Files

- `src/catalog.ts`: sites and accounts (scenario table).
- `src/data.ts`: the seeded generator.
- `src/metrics.ts`: aggregation and response shapes.
- `src/server.ts`: HTTP, OAuth and the API.
- `src/oauth.ts`: the code and token store, and the consent page.
- `src/ratelimit.ts`, `src/png.ts`, `src/sites.ts`, `src/cli.ts`, `src/index.ts`.
- `test/*.test.ts`: the tests. `test/helpers.ts` turns the OpenAPI 3.0 schemas into strict JSON Schema 2019-09 for ajv
  (`nullable`, no undeclared fields).
