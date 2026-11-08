# Backups and restore (ON HOLD)

> **Status: on hold — owner decision pending.** `infra/backup/backup.sh` and `restore.sh` are written and tested
> (`infra/backup/test-backup.sh`) but **not scheduled anywhere**. Neon's own point-in-time restore is the only backup
> until the owner decides the question below.

## The open question (CLAUDE.md non-negotiable 3)
"Disconnect = delete" requires raw and derived data to be purged within 24 h. A nightly dump kept for N days still holds
a disconnected account's data for up to N days. Options:
1. Keep encrypted dumps for a short window (e.g. 7 days, R2 lifecycle rule), say so in the privacy policy, and rely on
   the restore procedure below re-applying later purges before a restored copy serves traffic.
2. Exclude Pinterest-derived tables from dumps (accounts survive a disaster, metrics are re-synced).
3. No logical dumps; Neon point-in-time restore only (its history window has the same issue, shorter).
Neon PITR has the same property for its retention window. Whatever is chosen goes into `docs/policy/ASSUMPTIONS.md`
and `/privacy` (SPEC-071 currently lists no backup processor).

## What the scripts do
- `backup.sh`: one exported snapshot → exact per-table row counts **and** `pg_dump -Fc` of that same snapshot →
  AES-256 (openssl, PBKDF2 200k) with `BACKUP_PASSPHRASE` before touching disk → `<name>.dump.enc` + `<name>.json`
  (start time, sha256, row counts) to `BACKUP_DEST` (`s3://bucket/prefix` on Cloudflare R2, or a directory).
- `restore.sh <name|latest> <TARGET_OWNER_URL> <TARGET_APP_URL>`: verify sha256 → decrypt → `pg_restore` into an
  **empty** database only (single transaction, ownership kept: the `pgboss` schema belongs to `pinpulse_app`) → compare
  every table's row count with the manifest (must match exactly) → `scripts/reapply-purges.ts`: every connection in the
  **live** `deletion_log` requested since the backup started is disconnected (tokens cleared) and purged in the copy;
  fails if anything is left.

## If enabled (owner)
1. Cloudflare R2: bucket `pinpulse-staging-backups`; API token with Object Read & Write on that bucket only; lifecycle
   rule "delete after N days".
2. `/opt/pinpulse/.env`: `BACKUP_DEST=s3://pinpulse-staging-backups/nightly`, `BACKUP_PASSPHRASE` (`openssl rand -base64 32`;
   keep an offline copy — without it backups are unreadable), `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`.
3. Copy `infra/backup/` to `/opt/pinpulse/backup/` and add a systemd timer or cron entry, e.g.
   `37 2 * * * /opt/pinpulse/backup/backup.sh >> /opt/pinpulse/backup.log 2>&1`.
4. Restore drill (DEPLOYMENT.md "Done when"): create an empty database in a new Neon branch, then
   `ENV_FILE=/opt/pinpulse/.env /opt/pinpulse/backup/restore.sh latest <owner url of it> <pinpulse_app url of it>`.
   Expect `0 differ` and `re-applied N purge(s)`. Delete the branch afterwards.
