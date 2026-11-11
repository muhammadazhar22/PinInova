---
id: SPEC-080
title: Public pricing page
status: in-progress
owner: founder
risk: low   # public copy; prices read from the existing PLANS table, no billing logic change
spec_version: 1
---

## Why
`docs/DEPLOYMENT.md` Step 3 lists a public `/pricing` page as code to write before deploying: Paddle's domain review
looks at the live public site, and missing public pricing is one of the most common failures
(https://developer.paddle.com/partners/embed-billing/seller-go-live/prepare-for-go-live).

## User story
As a VA comparing tools, I can see PinInova's plans and prices without signing up.

## Acceptance criteria
- [x] `/pricing` is public (no login), linked from the footer's Legal navigation and the home page.
- [x] Prices, account limits, extra-account prices, alerts and report branding come from `PLANS` via `planFeatures()`,
      which the in-app billing page also uses, so the two cannot drift.
- [x] Names Paddle.com as Merchant of Record; links refunds and terms; no recovery promise (non-negotiable 5).
- [x] Tracked Pins (founder decision 11 Nov 2026: **raise**): `TRACKED_PINS_CAP` default 300 → 1,000, so Pro/Agency get
      the 1,000 in `PLANS` and Solo/trial keep 300. The feature list shows `deliveredTrackedPins()` = min(plan, cap), so
      it can never advertise more than sync delivers. Cost: one Pin-analytics call per tracked Pin per nightly sync
      (rate-gated per connection by `x-ratelimit-*`).
- [x] Tests: `plan-features.test.ts`; `e2e/legal.spec.ts` follows the footer link and checks $19/$39/$99 and Paddle.

## Out of scope
Checkout buttons (Paddle checkout is its own task), annual prices (not in `PLANS`), currency localisation.

## Data & policy
None. Copy only.
