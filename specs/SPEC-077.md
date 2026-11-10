---
id: SPEC-077
title: Rename the product from PinPulse to PinInova
status: in-progress
owner: founder
risk: medium   # touches legal-page and consent text (wording unchanged apart from the name)
spec_version: 1
---

## Why
The founder renamed the product to PinInova (the GitHub repository is `muhammadazhar22/PinInova`). Customers, Pinterest
reviewers and Paddle must see one name before staging goes public (docs/DEPLOYMENT.md Steps 2–4).

## Acceptance criteria
- [x] Every user-visible "PinPulse" says "PinInova": app shell, landing, auth, onboarding, consent, revoke, invite,
      drop check, weather, billing, settings, privacy, terms, refunds, footers, e-mails, reports, page titles.
- [x] Download filenames (`pininova-export-…json`, `pininova-<kind>-….pdf`) and the default `EMAIL_FROM` use the new name.
- [x] Link checks identify as `PinInovaLinkCheck/1.0` with header `X-PinInova-Check: 1` (PA-07 wording updated to match).
- [x] Mock Pinterest pages and mock sites say "PinInova development".
- [x] Internal identifiers keep the old name: `pinpulse_app` role, `pinpulse` database, `pinpulse_analytics` package,
      `pinpulse-app` / `pinpulse-analytics` images, staging resource names. CLAUDE.md says so.
- [x] Not edited: merged migrations (rule), `docs/research/*`, `docs/review-*` (historical records).
- [x] Gate: web typecheck + unit/RLS tests, analytics pytest, mock tests, `scripts/test-e2e.sh`, `scripts/test-browser.sh`.

## Out of scope
Buying a domain; the `pininova.app` URL in the link-check user agent is a placeholder until the real domain is chosen.
Renaming internal identifiers (would need a role/database migration and deploy changes; ask first).

## Data & policy
No behaviour change. Legal and consent wording is unchanged apart from the product name; the founder approved renaming
it on 10 Nov 2026.
