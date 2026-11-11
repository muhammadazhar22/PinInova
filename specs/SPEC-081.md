---
id: SPEC-081
title: Paddle checkout (sandbox first) and signed org binding
status: in-progress
owner: founder
risk: high   # billing; founder approved the task on 11 Nov 2026 ("do all of these")
spec_version: 1
---

## Why
DEPLOYMENT.md Step 3: "Paddle checkout (sandbox first): product/price IDs, checkout button, a new `paddle_live`
billing mode." Only webhooks and a simulated checkout existed. Found while building it: the webhook trusted
`custom_data.org_id`, which Paddle checkout takes from the buyer's browser, so anyone could open a checkout tagged with
another org and later cancel it, downgrading that org to `canceled`. Price IDs were made-up constants
(`pri_solo_monthly`), and one extra-account price can't serve Pro ($6) and Agency ($5).

## User story
As an agency owner on the trial, I click Checkout on the Pro plan, pay in Paddle's window, and my plan shows Pro.

## Acceptance criteria
- [x] `BILLING_MODE` gains `paddle_live`. With any Paddle mode the app refuses to start in production without
      `PADDLE_CLIENT_TOKEN`, `PADDLE_PRICE_SOLO|PRO|AGENCY`, `PADDLE_PRICE_EXTRA_PRO|AGENCY`; `paddle_live` refuses a
      sandbox (`test_…`) client token.
- [x] Plans map from configured price IDs; simulated mode keeps its stand-in IDs. Unknown prices grant no paid plan.
- [x] `checkoutConfig()` returns the Paddle.js overlay config: environment, token, items (plan + per-plan extra
      accounts, capped 0–200; none for Solo), `customData {org_id, org_sig}`, customer e-mail.
- [x] `org_sig` = HMAC-SHA256(BETTER_AUTH_SECRET, "paddle-checkout:v1:" + org id). Subscription events without a
      valid signature are recorded and acknowledged (200, no retry) but change nothing.
- [x] Billing page: in Paddle modes, owners/admins get a Checkout button per plan; an org already paying through
      Paddle is told to change or cancel through Paddle's receipt link or support (no second subscription);
      sandbox banner; success message after checkout. Removed the untrue "cancel any time from this page; prorated
      refunds within 14 days" line in favour of the refund policy link.
- [x] Tests: `paddle-checkout.test.ts` (config, missing settings, tampered/forged org, real vs simulated price IDs);
      existing `paddle.test.ts` (simulated flow) still passes.
- [ ] Sandbox end-to-end with real price IDs (needs the owner's Paddle sandbox account; runbook step 8).

## Out of scope
Plan changes and cancellation inside PinInova (Paddle's customer portal/receipt links are used), annual prices,
proration, the Paddle API key (not needed for overlay checkout).

## Data & policy
Paddle is Merchant of Record (terms, refunds). PinInova stores only the subscription state it already stored.

## Rollout
`BILLING_MODE=paddle_sandbox` on staging after runbook step 8; `paddle_live` only after Paddle verification
(DEPLOYMENT.md Step 6). Rollback: set `BILLING_MODE=simulated` (pre-launch) or revert.
