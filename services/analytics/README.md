# pinpulse-analytics

Stateless detection and diagnosis engine for PinPulse (Python package `pinpulse_analytics`, FastAPI).
Specs: SPEC-010 (CSV import), SPEC-011..014 (diagnose), SPEC-021 (pre-flight, duplicates), SPEC-030 (weather).

- **One tenant per request, nothing stored.** No database, no cache, no request-body logging.
- **No Pinterest calls** from this service (CLAUDE.md non-negotiable 1). The web app fetches data and posts series.
- Policy assumptions are cited in code by ID (`policy: PA-03`, `PA-06`, `PA-08`); see `docs/policy/ASSUMPTIONS.md`.

```sh
pip install -e ".[dev]"
./run.sh                                       # uvicorn on :8000 (PORT/HOST override)
pytest -q && ruff check . && mypy pinpulse_analytics --ignore-missing-imports
python -m pinpulse_analytics.export_openapi    # writes openapi.json (--check for CI)
python -m pinpulse_analytics.benchmark --seeds 7,11,23   # add --no-lead for a fast run
python -m pinpulse_analytics.benchmark --tune-cusum      # CUSUM threshold grid
```

## Endpoints

All JSON is snake_case. Validation failures return **422** (`{"detail": ...}`; pydantic list for schema errors, a
string for CSV/image/timestamp errors). `openapi.json` is the machine-readable contract.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/healthz` | `{"ok": true, "version": "1.0.0"}` |
| POST | `/v1/diagnose` | Changepoint, warning, rate stability, breadth, decomposition, cause classes with evidence |
| POST | `/v1/csv/parse` | Tolerant CSV import: `pinterest_analytics`, `ga4_sessions`, `shopify_orders`, `pin_drafts` |
| POST | `/v1/duplicates` | Transient 64-bit pHash, Hamming clusters (union-find) |
| POST | `/v1/weather` | Platform-wide index from voluntary user reports (Beta-Binomial) |
| POST | `/v1/preflight` | Rules over draft Pins, each labelled official / vendor / hypothesis |

### `/v1/diagnose`

Request: `impressions` and `outbound_clicks` (14..560 points) are required; `dates` (consecutive days, oldest first),
`saves`, `pin_clicks`, `age_buckets` (`"0-7"`, `"8-14"`, `"15-29"`, `"30+"`, each optional), `domains`,
`unlinked_impressions`, `pins` (per-Pin before/after totals), `signals`, `provisional_days` (default 2, 0..7),
`min_drop` (default 0.5) are optional. 422 on mismatched lengths, non-consecutive dates, negative/NaN values,
duplicate domains or pin ids, unknown fields.

**Two-pass flow for `pins`.** Per-Pin totals need an onset. Call once without `pins`; if `status == "drop"`, compute
each Pin's total over `[onset-14, onset)` and over `[onset, min(onset+14, n - provisional_days))` (scale the after
total to the before window length) and call again with `pins`. The benchmark does exactly this.

Response fields are as in the contract. `status`: `none`, `warning` (online CUSUM alarm, drop not yet confirmable),
`drop` (confirmed). For `none`/`warning`: `drop` is null, `classes` is `[]`, `rate.verdict` is `insufficient`,
`breadth` fields are null and `evidence` explains why. Evidence codes:
`drop_detected`, `methods_agree`/`methods_disagree`, `rate_stable`, `rate_fell`, `rate_rose`, `rate_insufficient`,
`save_rate_fell`, `shape_fade`, `shape_step`, `spike_returned`, `age_new_collapsed`, `age_mature_collapsed`,
`age_uniform`, `age_skipped_one_pin`, `domain_confined`, `domains_all_dropped`, `matched_pair_linked_low`,
`single_pin_drop`, `broad_pin_drop`, `top_heavy`, `domain_block_error`, `visit_site_demoted`, `bulk_or_ad_prefix`,
`duplicate_urls`, `peers_hit`, `peers_quiet`, `seasonal_yoy`, `ga4_direct_rose`, `early_warning`, `no_drop`.
`supports` lists the classes a rule raised; rules that only lower scores have `supports: []` and say so in `text`.

### `/v1/csv/parse`

`{"csv": text, "kind": ...}` → `{"kind", "rows", "columns_matched", "warnings", "date_range"}`. Handles BOM, `,` `;`
tab, quotes, preamble lines, GA4 `#` comment lines, thousands separators and decimal commas, `%`/currency symbols,
YYYY-MM-DD, YYYYMMDD, MM/DD/YYYY vs DD/MM/YYYY (decided from the whole column; ambiguous → month-first + warning),
"Mon D, YYYY", trailing total/summary rows, duplicate dates (summed, warned), Shopify line-item rows (merged per
order), `utm_*` parsed from `landing_site` when no UTM columns exist. Required columns (422 otherwise):
pinterest_analytics `date, impressions`; ga4_sessions `date, sessions, source|source/medium`; shopify_orders
`order_id, created_at, total_price, currency`; pin_drafts `title, board`.

### `/v1/duplicates`

`duplicate_rate = (Pins in clusters − clusters) / Pins with a hash` (share of Pins that are near-copies of another;
10 identical images → 0.9). Items with neither image nor hash are ignored. `hashes` is null unless `return_hashes`.
Policy PA-03: hashes are computed in memory and discarded. Limits: 5,000 items, 40 MP per image.

### `/v1/weather`

Binomial null with base rate p₀ (default 0.0017), or Beta-Binomial with precision φ (given, or method-of-moments
from the supplied history after trimming days with binomial tail p < 0.001; binomial if < 14 usable days).
`log_bf` uses a Beta(1, 20) alternative. Levels: `platform_wide` (tail p < 0.001 and fraction ≥ 0.10),
`elevated` (tail p < 0.01 or fraction ≥ 0.05), `normal`; fewer than 5 active reporters → `normal`,
`insufficient: true`. Additive response keys: `phi` (null = binomial) and `model`.

### `/v1/preflight`

Rule ids: `same_url_7d` (vendor), `bulk_day` (hypothesis; >25 drafts on one UTC date; `draft_index` null),
`ad_prefix` (hypothesis; description starts with `#ad`, not `#adventure`), `keyword_stuffing` (official spam rule;
PinPulse thresholds: a token ≥4 times and ≥10% of words, >10 hashtags, or a repeated hashtag), `link_shortener`
(official no-surprises rule, error), `redirect_link` (same rule, warning), `title_length` (>100 chars, API limit,
error), `missing_link` (info), `engagement_bait` (12 Nov 2026 guidelines, error). Drafts without `scheduled_at` are
treated as publishing at `now`. URLs are compared without `www.`, fragment, trailing slash and `utm_*`.

## Pipeline (`detectors.py`, DETECTOR_VERSION 2.0.0)

1. `y = log1p(impressions)` on complete days only (the last `provisional_days` are excluded from confirmation,
   PA-08). Robust STL (period 7) when ≥ 28 points, kept only if it reduces day-to-day roughness (guards a robust-STL
   breakdown on near-noiseless steps).
2. PELT (`ruptures`, l2 cost with cumulative sums, min_size 7, β = σ̂² log T, σ̂ = 1.4826·MAD of first differences),
   then each changepoint is re-located by a local single split (±6 days) to remove min_size boundary bias.
   Cross-check: PELT with the rank cost (β = log T); `methods_agree` if within ±2 days.
3. Confirmation: raw-scale median effect ≥ `min_drop` over 14-day windows, ≥ 5 complete post days, not recovered
   (median of the last 7 complete days ≤ (1 − min_drop/2) × before). Qualifying changepoints within 14 days form one
   event (the one with the largest adjacent-segment fall); the event that fell from the highest level is reported.
   `p_value`: one-sided Mann–Whitney on deseasonalised log values (pre vs post), for BH across accounts.
4. Online CUSUM on log1p, strictly causal: expected = trailing-28-day median + ½ same-weekday deviation,
   k = log(2)/2, alarm when S > 5.25·σ_t (tuned to ≈1 false alarm per account-year). `warning` needs an active
   alarm, < 7 complete days since the run began, and ≥ 1 complete day in the run (lag alone cannot warn).
5. Shape: grid of ramp models (step = 1 day, fade = ≥ 4 days); `fade` needs SSE gain > 3σ² log N and ≥ Δ²L/48.
   A fading spike (rise ≥ 60% within 28 days, now back within 40% of the pre-rise level) or a fade re-dates the onset
   to the start of the decline.
6. Rates: outbound clicks / impressions, pre τ−28..τ−1 vs post τ..τ+27 (complete days). Beta-Binomial log BF with
   an empirical-Bayes Beta(2, 2(1−r̂)/r̂) prior (a uniform prior penalises the two-rate model at 1-3% CTR), counts
   deflated by the Pearson dispersion of pre-window days; `changed` when log BF > 1 and P(ρ < 0.8) > 0.8 (or
   P(ρ > 1.25) > 0.8); `insufficient` below 500 post impressions. Saves rate is evidence only.
7. Breadth over the same windows: age-bucket ratios, per-domain ratio and share, linked vs unlinked. Decomposition:
   exact additive per-Pin deltas (top 20), top-1% share, Gini, top Pin's share of the loss.
8. Rule scores (+ priors) → softmax over the six causes; every contribution is an evidence item.

No lookahead: CUSUM and warnings use only data ≤ t (tested exactly). Offline steps refit on the series as received;
on truncation 14 days after onset the date stays within ±2 days in ≥ 90% of cases (tested), exactly equal in most.

## Benchmark (generator v2, pin-level)

`synth.py` simulates Pins (lifecycle with a fresh-Pin boost, heavy-tailed weights, 1-4 domains plus unlinked Pins,
shared daily Gamma shock, per-Pin NB noise, reporting lag on the last 2 days) and sums them into every series the
detector sees. Classes act on Pins: A one domain cut; B all Pins down and click/save rates down; C Pins published
from a week before onset get no distribution; D broad cut or retrieval-side cut of Pins > 7 days old; E a viral Pin
plateaus then fades; no-cliff accounts include strong weekly seasonality, holiday dips that recover and slow
seasonal declines. Every class gets a post-onset audience-mix CTR shift. Label hygiene: accounts whose noise-free
organic mean has an unlabelled ≥ 35% fall are redrawn. Side signals stay noisy and incomplete,
`peers_hit_fraction` is None, 25% of accounts have no breadth data. Not comparable with generator v1 rows.

| Seed | onset P | onset R | onset F1 | FAR | class acc | top-2 | score | naive F1 | delay (d) | warn lead (d) | CUSUM FA/acct-yr |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 7 | 0.853 | 0.814 | 0.833 | 0.016 | 0.849 | 0.974 | **0.870** | 0.286 | 6.67 | 4.27 | 1.29 |
| 11 | 0.887 | 0.846 | 0.866 | 0.017 | 0.809 | 0.897 | **0.867** | 0.260 | 6.67 | 4.26 | 0.80 |
| 23 | 0.882 | 0.868 | 0.875 | 0.052 | 0.867 | 0.957 | **0.886** | 0.213 | 6.61 | 4.61 | 0.81 |

Per class, accuracy among detected cliffs (recall ±2 d in brackets):

| Seed | A_enforcement | B_quality | C_behavioural | D_platform | E_decay | no breadth data |
| --- | --- | --- | --- | --- | --- | --- |
| 7 | 0.80 (0.88) | 0.90 (0.73) | 0.91 (0.89) | 0.85 (0.82) | 0.62 (0.65) | 0.69 |
| 11 | 0.70 (0.86) | 0.88 (0.91) | 0.74 (0.90) | 0.87 (0.83) | 0.80 (0.65) | 0.59 |
| 23 | 0.76 (0.94) | 0.89 (0.92) | 0.90 (0.83) | 0.88 (0.92) | 0.83 (0.40) | 0.67 |

Delay = days from true onset until the drop is confirmable with data through that day (minimum 6 with 5 complete
post days and 2 provisional). Warnings precede confirmation in 95-99% of matched cliffs. `benchmark_baseline.json`
holds seed 7. Weakest areas: E recall (fades are dated late; smooth fades are inherently ±2-day ambiguous) and
classification without breadth data (A vs D is ambiguous without per-domain series).

## Assumptions

- **Pinterest native CSV column names are not verified.** Aliases accepted for `pinterest_analytics`: Date/Day;
  Impressions; Outbound clicks/Link clicks/Website clicks; Pin clicks/Closeups; Saves/Repins; Engagements;
  Total audience. `columns_matched` records which header matched each field; please send real exports so the
  alias list can be confirmed.
- Organic analytics lag about 48 h (PA-08, community-sourced): `provisional_days` defaults to 2.
- Pre-flight thresholds (25/day, 7-day URL spacing, keyword repetition, shortener list) are PinPulse heuristics;
  `policy_ref` says so. The `#ad` and bulk-day rules are hypotheses from community reports.
- Weather inputs are voluntary user reports only (PA-06); `base_rate` 0.0017 is a placeholder (3% of accounts cliff
  per quarter, 5-day window) to be re-estimated from reports.
- The benchmark is synthetic. Real labelled series (concierge audits) must be scored separately before any accuracy
  claim reaches users.

## Authentication (SPEC-075)

Set `ANALYTICS_TOKEN` (32+ characters, e.g. `openssl rand -base64 32`) and every route except `/healthz` requires
`Authorization: Bearer <ANALYTICS_TOKEN>`. Leave it unset only for local development and tests. The web app sends the
same variable; production refuses to start without it.
