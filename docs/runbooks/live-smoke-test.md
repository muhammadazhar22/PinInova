# Live Pinterest smoke test

`apps/web/scripts/smoke-live.ts` (SPEC-076) checks, against **real** Pinterest responses, the contract details the mock
had to guess (docs/INTEGRATIONS.md, "Contract details the mock had to guess"). It is read-only: six GET calls through
the rate-gated client plus one `robots.txt` request per claimed site (max 3). It stores nothing and prints only
shapes and counts — never metric values, Pin IDs or tokens.

Run it in docs/DEPLOYMENT.md Step 4.3, after the owner switched staging to `PINTEREST_MODE=live` and connected their
own business account through the real consent screen. Never switch modes from a script or a CI job.

## Run
1. Open the connected account in the app. The URL is `https://staging.<domain>/app/w/<WORKSPACE_ID>/a/<CONNECTION_ID>`.
2. Optional, for check 5: in Pinterest Analytics, export the account's overview as CSV and copy it to the server
   (`scp export.csv deploy@<server>:/tmp/`), then add `-v /tmp/export.csv:/tmp/export.csv:ro` and `--csv /tmp/export.csv`.
3. On the server:
   ```bash
   cd /opt/pinpulse && docker compose -f docker-compose.prod.yml run --rm --entrypoint node_modules/.bin/tsx web scripts/smoke-live.ts --workspace <WORKSPACE_ID> --connection <CONNECTION_ID>
   ```
   Add `--json` for a machine-readable report. Exit code 1 means at least one check failed.

## Reading the result

| Check | Contract detail (INTEGRATIONS.md) | If it fails or warns |
|---|---|---|
| `analytics_split_keys` | Analytics split keys (`all` for NO_SPLIT; enum values for OWNED_CONTENT); dates `YYYY-MM-DD`; metric names | Adjust `flattenAnalytics` / `METRIC_MAP` (`src/modules/pinterest/client.ts`, `src/modules/sync/sync.ts`) and the mock (`services/pinterest-mock`), re-record the contract test |
| `pa08_provisional_days` | PA-08: how many recent days are not `READY` | If not 2, set `PROVISIONAL_DAYS` and record the observation under PA-08 (dated, with source) — do not mark PA-08 resolved without a written Pinterest source |
| `timestamps` | RFC 3339 with or without offset | A warn means naive timestamps are stored as UTC; confirm and note it |
| `user_account_websites` | `website` with/without scheme; status values | Unknown statuses: extend `isClaimed()` (`src/modules/health/score.ts`) |
| `robots_txt` | Live robots.txt at `/robots.txt` of each claimed site | A warn is usually the site itself (timeout, TLS); re-run before changing code |
| `analytics_csv_export` | Native CSV export column names | Add aliases in `services/analytics/pinpulse_analytics/csv_parse.py` |

After a clean run, update the "Contract details the mock had to guess" table in docs/INTEGRATIONS.md with the date and
what was observed. Pinterest stays "Implemented; mock-tested only" until a week of clean production syncs (DEPLOYMENT.md
Step 6).
