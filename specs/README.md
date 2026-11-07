# Specs

One file per feature. Agents implement from specs, never from chat. Frontmatter:

```yaml
---
id: SPEC-012
title: Health scan: cliff detection and alert
status: draft | approved | in-progress | shipped
owner: founder
risk: low | medium | high        # high = touches billing, OAuth, deletion, policy
spec_version: 3
---
```

Required sections:
1. **Why** — the user problem, with 1–3 evidence links (forum thread, interview note).
2. **User story** — "As a VA managing 12 client accounts, I …".
3. **Acceptance criteria** — checkboxes. Each must be testable by a machine or a screenshot.
4. **Out of scope** — explicit.
5. **Data & policy** — which Pinterest fields are read, retention, whether any cross-user computation happens (must be "none" unless SPEC-030).
6. **Design** — link to the Design artboard or a wireframe; states: empty, loading, error, success, no-data (<14 days).
7. **Test plan** — unit, contract fixture, e2e path, benchmark impact (for detector work).
8. **Rollout** — flag name, % ramp, metrics to watch, rollback.

Index (seed):

| ID | Title | Release | Risk |
| --- | --- | --- | --- |
| SPEC-001 | Pinterest OAuth connect/disconnect with delete-on-disconnect | v1 | high |
| SPEC-002 | Nightly analytics sync with per-user rate limiting | v1 | medium |
| SPEC-003 | 90-day rolling retention and purge job | v1 | high |
| SPEC-010 | CSV import for v0 Drop Check | v0 | low |
| SPEC-011 | Changepoint detection (PELT on log1p) | v0 | low |
| SPEC-012 | Cause classifier v1 (rule scores) | v1 | medium |
| SPEC-013 | Engagement-rate stability test | v1 | low |
| SPEC-014 | Top-Pin decomposition | v0 | low |
| SPEC-020 | Link & domain integrity checks | v1 | low |
| SPEC-021 | Pre-flight compliance rules (post 12 Nov 2026 guidelines) | v1 | medium |
| SPEC-022 | Appeal evidence pack PDF | v1 | low |
| SPEC-023 | Monthly client report PDF | v1 | low |
| SPEC-030 | Weather index (user-reported; API-pooled only with authorization) | v3 | high |
| SPEC-040 | Agency workspaces, roles, per-client consent | v2 | high |
| SPEC-041 | GA4 Traffic Leak Check | v2 | medium |
| SPEC-050 | Shopify order join via utm_content tokens | v3 | high |
| SPEC-060 | Billing via Paddle (merchant of record) | v1 | high |
