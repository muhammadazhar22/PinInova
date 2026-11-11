---
id: SPEC-001
title: Pinterest OAuth connect/disconnect with delete-on-disconnect
status: shipped
owner: founder
risk: high   # OAuth and plan limits (billing)
spec_version: 2
---

This spec shipped before `specs/` held one file per feature; the original behaviour is covered by
`test/pipeline.e2e.test.ts` (connect, consent link, revoke, purge) and `src/modules/privacy/review-fixes.test.ts`.
This file records amendments.

## Amendment 1 (11 Nov 2026): reconnect at the plan's account limit

### Why
A connection whose token Pinterest rejects is flagged `needs_reauth` and its page shows **Reconnect**. Accounts in
`needs_reauth` count toward the plan's limit (`system_org_active_accounts`), and both the Connect route and the OAuth
callback refused when `count >= limit` before knowing which account was connecting. So a customer at their limit whose
token expired could never reconnect: found on the demo workspace (trial, 5 of 5 accounts) on 11 Nov 2026.

### User story
As a VA on the Pro plan with 5 client accounts, when one client's Pinterest login expires I press Reconnect and it
works, without disconnecting anything.

### Acceptance criteria
- [x] Reconnecting a Pinterest account that the workspace already has (`active` or `needs_reauth`) is allowed at the
      limit, because it replaces that connection's tokens and does not add an account. It reuses the same connection row.
- [x] A new account is still refused at the limit (`plan_limit`), with the same message as before.
- [x] Reconnect is refused when the org is over its limit or has none (canceled plan, expired trial).
- [x] The callback checks the limit after identifying the account; refused tokens are never stored.
- [x] The Reconnect button passes `reconnect=<connection id>`; the Connect route allows it at the limit only for a
      connection in that workspace whose status is `needs_reauth`.
- [x] Test: `apps/web/src/modules/pinterest/reconnect.test.ts` (Solo plan, 1 account).

### Out of scope
Changing plan limits or which statuses count toward them. Revoking tokens obtained in a refused callback (they expire).

### Data & policy
No new data. Scopes unchanged (read-only; write scopes still refused before any check).

### Rollout
No flag. Rollback: revert; reconnect at the limit is blocked again (workaround: disconnect and connect).
