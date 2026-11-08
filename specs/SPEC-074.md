---
id: SPEC-074
title: Nightly encrypted pg_dump to R2 and a restore script
status: draft   # ON HOLD — owner decision on backups vs disconnect = delete
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
