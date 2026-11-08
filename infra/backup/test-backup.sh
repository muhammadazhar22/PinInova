#!/usr/bin/env bash
# End-to-end test of backup.sh + restore.sh against local Postgres (SPEC-074). Needs Docker, the app image
# (APP_IMAGE, default pinpulse-app:stacktest from infra/test-stack.sh) and a populated source database — by default the
# pipeline e2e database (run scripts/test-e2e.sh first).
#   1. back up SOURCE (encrypted, to a local directory);
#   2. after the backup, a connection is disconnected in SOURCE (deletion_log row);
#   3. restore into an empty database: checksums, exact row counts, and the later purge re-applied.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PG="${PG:-postgres://postgres:dev@localhost:5432}"
export DATABASE_OWNER_URL="${SOURCE:-$PG/pinpulse_test}" BACKUP_PASSPHRASE="$(openssl rand -base64 32)" BACKUP_DEST="$(mktemp -d)"
export APP_IMAGE="${APP_IMAGE:-pinpulse-app:stacktest}" ENV_FILE=/dev/null
TARGET_DB=pinpulse_restore_test
q() { docker run --rm --network host postgres:16 psql "$1" -qAtX -v ON_ERROR_STOP=1 -c "$2"; }

read -r CONN WS < <(q "$DATABASE_OWNER_URL" "SELECT id, workspace_id FROM pinterest_connection c WHERE status = 'active' AND EXISTS (SELECT 1 FROM account_metrics_daily m WHERE m.connection_id = c.id) LIMIT 1" | tr '|' ' ')
[ -n "${CONN:-}" ] || { echo "source has no active connection with metrics; run scripts/test-e2e.sh first"; exit 1; }

"$ROOT/infra/backup/backup.sh"
ls "$BACKUP_DEST" | grep -q '\.dump\.enc$' && ! grep -qa "account_metrics_daily" "$BACKUP_DEST"/*.dump.enc && echo "ok   backup written and encrypted"

sleep 1
q "$DATABASE_OWNER_URL" "INSERT INTO deletion_log (connection_id, workspace_id, reason, requested_at) VALUES ('$CONN', '$WS', 'user', now())"
q "$PG/postgres" "DROP DATABASE IF EXISTS $TARGET_DB WITH (FORCE)"
q "$PG/postgres" "CREATE DATABASE $TARGET_DB"

APP_PW="$(sed -E 's#.*//pinpulse_app:([^@]*)@.*#\1#' <<<"${APP_URL_FOR_TEST:-postgres://pinpulse_app:pinpulse_app@x}")"
"$ROOT/infra/backup/restore.sh" latest "$PG/$TARGET_DB" "postgres://pinpulse_app:$APP_PW@localhost:5432/$TARGET_DB"

status="$(q "$PG/$TARGET_DB" "SELECT status FROM pinterest_connection WHERE id = '$CONN'")"
left="$(q "$PG/$TARGET_DB" "SELECT count(*) FROM account_metrics_daily WHERE connection_id = '$CONN'")"
others="$(q "$PG/$TARGET_DB" "SELECT count(*) FROM account_metrics_daily WHERE connection_id <> '$CONN'")"
[ "$status" = purged ] && [ "$left" = 0 ] && [ "$others" -gt 0 ] || { echo "FAIL status=$status left=$left others=$others"; exit 1; }
echo "ok   connection disconnected after the backup is purged in the restored copy; other data intact ($others metric rows)"

if ! "$ROOT/infra/backup/restore.sh" latest "$PG/$TARGET_DB" "postgres://pinpulse_app:$APP_PW@localhost:5432/$TARGET_DB" >/dev/null 2>&1; then
  echo "ok   restore refuses a non-empty target"
else echo "FAIL restore into a non-empty database succeeded"; exit 1; fi
q "$DATABASE_OWNER_URL" "DELETE FROM deletion_log WHERE connection_id = '$CONN' AND completed_at IS NULL"
q "$PG/postgres" "DROP DATABASE $TARGET_DB WITH (FORCE)"; rm -rf "$BACKUP_DEST"
echo "backup test passed"
