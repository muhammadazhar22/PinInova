#!/usr/bin/env bash
# Restore drill / disaster recovery (SPEC-074) — ON HOLD with backup.sh; see docs/runbooks/backup-restore.md.
#   infra/backup/restore.sh <name|latest> <TARGET_OWNER_URL> <TARGET_APP_URL>
# 1. fetch <name>.dump.enc + <name>.json from BACKUP_DEST, verify sha256, decrypt with BACKUP_PASSPHRASE;
# 2. pg_restore into an EMPTY target database (e.g. a fresh Neon branch/database), as its owner;
# 3. compare every table's row count with the manifest (taken in the dump's own snapshot): must match exactly;
# 4. disconnect = delete: re-apply every purge recorded in the LIVE database (DATABASE_OWNER_URL) since the dump, so
#    connections deleted after the backup do not come back. The target must not serve traffic before this succeeds.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT/.env}"
getenv() { [ -n "${!1:-}" ] && { echo "${!1}"; return; }; grep -E "^$1=" "$ENV_FILE" 2>/dev/null | tail -n 1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//'; }
WANT="${1:?usage: restore.sh <name|latest> <TARGET_OWNER_URL> <TARGET_APP_URL>}"; TARGET="${2:?target owner url}"; TARGET_APP="${3:?target app url}"
PASS="$(getenv BACKUP_PASSPHRASE)"; DEST="$(getenv BACKUP_DEST)"; LIVE="$(getenv DATABASE_OWNER_URL)"
PG_IMAGE="${PG_IMAGE:-postgres:16}"; APP_IMAGE="${APP_IMAGE:-ghcr.io/muhammadazhar22/pinpulse-app:$(cat "$ROOT/.deployed-tag" 2>/dev/null || echo staging)}"
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT; chmod 700 "$WORK"

aws_() { docker run --rm -e AWS_ACCESS_KEY_ID="$(getenv R2_ACCESS_KEY_ID)" -e AWS_SECRET_ACCESS_KEY="$(getenv R2_SECRET_ACCESS_KEY)" \
  -e AWS_DEFAULT_REGION=auto -v "$WORK:/w" amazon/aws-cli:2.27.0 "$@" --endpoint-url "https://$(getenv R2_ACCOUNT_ID).r2.cloudflarestorage.com"; }
case "$DEST" in
  s3://*)
    [ "$WANT" != latest ] || WANT="$(aws_ s3 ls "${DEST%/}/" | awk '{print $4}' | grep '\.json$' | sort | tail -n 1 | sed 's/\.json$//')"
    aws_ s3 cp "${DEST%/}/$WANT.dump.enc" /w/dump.enc --only-show-errors; aws_ s3 cp "${DEST%/}/$WANT.json" /w/manifest.json --only-show-errors ;;
  *)
    [ "$WANT" != latest ] || WANT="$(ls "$DEST"/*.json | sort | tail -n 1 | xargs -n1 basename | sed 's/\.json$//')"
    cp "$DEST/$WANT.dump.enc" "$WORK/dump.enc"; cp "$DEST/$WANT.json" "$WORK/manifest.json" ;;
esac
SHA="$(sha256sum "$WORK/dump.enc" | cut -d' ' -f1)"
grep -q "\"sha256\":\"$SHA\"" "$WORK/manifest.json" || { echo "checksum mismatch for $WANT"; exit 1; }
CREATED="$(sed -E 's/.*"created_at":"([^"]+)".*/\1/' "$WORK/manifest.json")"
echo "restoring $WANT (taken $CREATED)"

docker run --rm --network host -e DB="$TARGET" -e PASS="$PASS" -v "$WORK:/w" "$PG_IMAGE" bash -euo pipefail -c '
  n=$(psql "$DB" -qAtX -c "SELECT count(*) FROM pg_tables WHERE schemaname = '"'"'public'"'"'")
  [ "$n" = 0 ] || { echo "target database is not empty ($n tables); restore only into an empty database"; exit 1; }
  openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass env:PASS -in /w/dump.enc -out /w/dump
  # Keep ownership: the pgboss schema belongs to pinpulse_app. Restore as the same owner role (same Neon project).
  pg_restore --exit-on-error --single-transaction -d "$DB" /w/dump
  psql "$DB" -qAtX -c "SELECT json_object_agg(t, n) FROM (SELECT c.relname AS t,
      (xpath('"'"'/row/n/text()'"'"', query_to_xml(format('"'"'SELECT count(*) AS n FROM ONLY %I.%I'"'"', n.nspname, c.relname), false, true, '"'"''"'"')))[1]::text::bigint AS n
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('"'"'r'"'"') AND n.nspname = '"'"'public'"'"' ORDER BY 1) s" > /w/restored.json
  rm -f /w/dump'

python3 - "$WORK/manifest.json" "$WORK/restored.json" <<'PY'
import json, sys
want = json.load(open(sys.argv[1]))["row_counts"]; got = json.load(open(sys.argv[2]))
diff = {t: (want.get(t), got.get(t)) for t in sorted(set(want) | set(got)) if want.get(t) != got.get(t)}
print(f"row counts: {len(want)} tables, {sum(want.values())} rows in backup; {len(diff)} differ")
for t, (w, g) in diff.items(): print(f"  {t}: backup {w} restored {g}")
sys.exit(1 if diff else 0)
PY

# Purge needs no secrets (it deletes rows and clears sealed tokens); NODE_ENV=development skips the server-only guard.
docker run --rm --network host -e NODE_ENV=development -e SOURCE_OWNER_URL="$LIVE" -e DATABASE_URL="$TARGET_APP" \
  --entrypoint node_modules/.bin/tsx "$APP_IMAGE" scripts/reapply-purges.ts --since "$CREATED"
echo "restore of $WANT complete: counts match, later purges re-applied"
