---
id: SPEC-074
title: Nightly encrypted pg_dump to R2 and a restore script
status: in-progress   # owner chose option A on 11 Nov 2026: no Pinterest data in backups
owner: founder
risk: high   # data deletion
spec_version: 1
---

## Why
docs/DEPLOYMENT.md Step 3: nightly `pg_dump` to Cloudflare R2 plus a restore script; "Done when" includes a restore drill.

## Acceptance criteria
- [x] Dump and row counts come from one exported snapshot; encrypted before it touches disk; sha256 + manifest.
- [x] Restore only into an empty database; checksum verified; exact row-count comparison with the manifest.
- [x] Purges recorded in the live `deletion_log` since the backup started are re-applied in the restored copy before it
      may serve traffic (non-negotiable 3 survives a restore).
- [x] `infra/backup/test-backup.sh` passes locally (backup → disconnect after backup → restore → counts equal → that
      connection purged, others intact → non-empty target refused).
- [ ] Owner decides retention / scope (docs/runbooks/backup-restore.md); privacy page and ASSUMPTIONS updated.
- [ ] Scheduled on the server; restore drill on a fresh Neon branch.

## Rollout
Not scheduled. Nothing runs until the owner enables it.

## Decision (11 Nov 2026): option A
The owner chose to keep Pinterest data out of backups.
- [x] `infra/backup/pinterest-data-tables.txt` = the disconnect purge's tables (`PURGED_TABLES`); unit test keeps them equal.
- [x] `backup.sh` dumps those tables schema-only (and their monthly partitions); manifest records `excluded_data` and
      counts them as 0; refuses to run with an empty list.
- [x] `restore.sh` expects them empty; `APP_IMAGE=local` runs the purge re-apply from the repo (tests).
- [x] `/privacy` discloses 14-day encrypted backups without Pinterest analytics/Pins/results, the residual username +
      encrypted token, and re-applied disconnections; Cloudflare listed as backup storage.
- [x] `test-backup.sh` (local, against the e2e database): no Pinterest data restored; users and other connections back;
      a disconnect after the backup is purged in the copy; restore refuses a non-empty target.
- [ ] Owner: R2 bucket with a 14-day lifecycle rule, server `.env`, cron entry, first restore drill (runbook).
