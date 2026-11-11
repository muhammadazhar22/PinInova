---
id: SPEC-079
title: New Pins not distributed while the account total holds
status: in-progress
owner: founder
risk: low   # new warning from data already stored; no new API call, scope, retention or policy text
spec_version: 1
---

## Why
PLAN.md lists five recurring signatures in creator reports; the first is "new Pins at 0–1 impressions while old Pins
perform" (behavioural / cause C, e.g. duplicate images, one link repeated, bulk uploads). The detector only looks for
causes after the **account** total falls by at least `min_drop` (50%). When older Pins carry the account, a new-Pin
collapse never crosses that threshold, so PinInova reported nothing: `mock_new_pins_zero` (40-Pin burst, ~75% one link
and one image) scored "good" with no finding on 11 Nov 2026. The e2e test named "new Pins at zero: behavioural cause
and duplicate images detected" only asserted the duplicates.

Evidence: https://community.pinterest.biz/t/pinterest-impressions-dropped-after-vmp-review-new-pins-not-getting-reach/49360 ·
https://community.pinterest.biz/t/the-truth-about-duplicate-pins-why-your-impressions-dropped-to-zero/31189

## User story
As a blogger who scheduled a batch of Pins, I see within days that my new Pins are getting almost no views even
though my account total looks normal, with the numbers and the likely reasons, before I schedule the next batch.

## Acceptance criteria
- [ ] Every analysis compares tracked Pins created 4–21 days ago ("new") with Pins
      created more than 35 days ago ("older"): each Pin's mean daily impressions over complete days (from its 3rd day,
      last 16 days, excluding the provisional days), then the **median** of each group.
- [ ] A warning issue `distribution:new_pins` opens when new median ≤ 20% of older median, with at least 8 new Pins,
      at least 20 older Pins and an older median of at least 5 impressions/day. Otherwise it closes.
- [ ] Title states the numbers ("N new Pins from the last 3 weeks get about X views a day; older Pins get Y");
      detail gives counts, medians, ratio, the window and likely reasons in "likely cause" language (non-negotiable 5).
- [ ] Pure, unit-tested rule (`src/modules/health/new-pins.ts`): flags the mock signature (ratio ≈ 0.05); does not flag
      ratio ≈ 1, too few new or older Pins, or a low-traffic account.
- [ ] e2e: `mock_new_pins_zero` gets `distribution:new_pins`; `mock_healthy` and `mock_viral_fade` do not.
- [ ] Mock calibration (11 Nov 2026, new ÷ older median): new_pins_zero 0.05; domain_block 1.6, platform_cliff 1.4,
      quality_drop 0.99, viral_fade 0.97. No false positive on the five connected mock accounts.

- [x] Follow-up (founder request, 11 Nov 2026): `NEW_PINS_ALERTS` (default **false**). When true, alert evaluation
      sends one in-app alert and one e-mail per open `distribution:new_pins` issue (tier `new_pins`; no Slack), with
      likely-cause wording. Test: `src/modules/alerts/new-pins-alerts.test.ts` (off by default, on, no duplicates).

## Out of scope
Changing the detector (`detectors.py`), the benchmark or the health-score formula. Turning `NEW_PINS_ALERTS` on by
default: wait until beta labels show the warning is accurate on real accounts.

## Data & policy
Uses `pin_meta.pin_created_at` and `pin_metrics_daily` already stored for this connection (PA-01/PA-02). No new
Pinterest call, no cross-user computation.

## Test plan
Unit (pure rule), e2e (8 mock scenarios), full gate. Benchmark untouched (no detector change).

## Rollout
No flag. Watch: share of accounts with the issue open; user feedback on it. Rollback: revert; open issues of this kind
stay until closed manually (or delete rows with `kind = 'distribution:new_pins'`).
