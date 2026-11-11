# Backups and restore

> **Decided 11 Nov 2026 by the owner: option A.** Backups hold **no Pinterest data**, so "disconnect = delete"
> (CLAUDE.md non-negotiable 3) holds for everything Pinterest gave us. Not scheduled until the owner enables it on the
> server (below). Until then Neon's point-in-time restore is the only backup.

## What is and isn't in a backup
- **Left out (schema only, rows empty):** the tables in `infra/backup/pinterest-data-tables.txt`: the same ones the
  disconnect purge deletes (metrics, Pin metadata, incidents, issues, link checks, health, reports, alerts, e-mail
  outbox, …). A unit test (`apps/web/src/modules/privacy/backup-tables.test.ts`) fails if the two lists drift.
- **Kept:** users, organisations, workspaces, billing, settings, consent records, deletion log, weather reports and
  `pinterest_connection` (username, Pinterest user id, **encrypted** tokens). After a restore everyone stays
  connected and the nightly sync re-fetches the last 90 days, the same window raw data is kept for anyway (PA-01).
- **Residual:** a disconnected account's username and encrypted token stay in older backups until the 14-day R2
  lifecycle rule deletes them; restore re-applies every later disconnection before use. The privacy page says so.
- Neon point-in-time restore has a similar window for the whole database (Neon's own retention setting).

## What the scripts do
- `backup.sh`: one exported snapshot → exact per-table row counts **and** `pg_dump -Fc` of that same snapshot →
  AES-256 (openssl, PBKDF2 200k) with `BACKUP_PASSPHRASE` before touching disk → `<name>.dump.enc` + `<name>.json`
  (start time, sha256, row counts) to `BACKUP_DEST` (`s3://bucket/prefix` on Cloudflare R2, or a directory).
- `restore.sh <name|latest> <TARGET_OWNER_URL> <TARGET_APP_URL>`: verify sha256 → decrypt → `pg_restore` into an
  **empty** database only (single transaction, ownership kept: the `pgboss` schema belongs to `pinpulse_app`) → compare
  every table's row count with the manifest (must match exactly) → `scripts/reapply-purges.ts`: every connection in the
  **live** `deletion_log` requested since the backup started is disconnected (tokens cleared) and purged in the copy;
  fails if anything is left.

## Enable (owner)
1. Cloudflare R2: bucket `pinpulse-staging-backups`; API token with Object Read & Write on that bucket only; lifecycle
   rule **"delete after 14 days"** (the privacy page promises 14).
2. `/opt/pinpulse/.env`: `BACKUP_DEST=s3://pinpulse-staging-backups/nightly`, `BACKUP_PASSPHRASE` (`openssl rand -base64 32`;
   keep an offline copy — without it backups are unreadable), `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`.
3. Copy `infra/backup/` to `/opt/pinpulse/backup/` and add a systemd timer or cron entry, e.g.
   `37 2 * * * /opt/pinpulse/backup/backup.sh >> /opt/pinpulse/backup.log 2>&1`.
4. Restore drill (DEPLOYMENT.md "Done when"): create an empty database in a new Neon branch, then
   `ENV_FILE=/opt/pinpulse/.env /opt/pinpulse/backup/restore.sh latest <owner url of it> <pinpulse_app url of it>`.
   Expect `0 differ`, `re-applied N purge(s)` and empty Pinterest data tables. Delete the branch afterwards.
