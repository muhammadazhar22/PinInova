---
id: SPEC-071
title: Public privacy, terms and refund pages
status: in-progress
owner: founder
risk: high   # policy text
spec_version: 1
---

## Why
docs/DEPLOYMENT.md Steps 2–3: Paddle domain review and Pinterest app review need a public site with privacy, terms and
refund pages; terms must name Paddle as merchant of record. (`/pricing` is on hold with the billing items.)

## Acceptance criteria
- [x] `/privacy`, `/terms`, `/refunds` render without a login; linked from a footer on every page.
- [x] Numbers come from the switches the code enforces (`src/lib/legal.ts`): raw/derived retention (PA-01), scopes,
      purge window, re-auth grace, e-mail retention, consent-link lifetime.
- [x] Operator name, support e-mail, governing law, effective date and refund window come from env and render as
      visible `[to be set: …]` placeholders until set.
- [x] Terms name Paddle.com as Merchant of Record.
- [x] Copy guard (`src/lib/legal.test.ts`) over all pages, e-mail and report templates: no "guarantee" anywhere, and no
      claim of Pinterest approval/partnership except as a denial.
- [x] Browser e2e `e2e/legal.spec.ts`.

## Out of scope
`/pricing`, Paddle checkout (billing on hold); agency DPA; legal review.

## Data & policy
Describes existing behaviour only; no data change. Every statement was checked against the code (see PR).

## Rollout
Set the five `LEGAL_*`/`SUPPORT_EMAIL`/`REFUND_WINDOW_DAYS` values on staging. Rollback: revert.
