#!/usr/bin/env bash
# Nightly logical backup (SPEC-074). Owner decision 11 Nov 2026 (option A): backups hold NO Pinterest data. The tables
# in pinterest-data-tables.txt (the same ones the disconnect purge deletes) are dumped schema-only, so a restored copy
# starts with empty metrics and the nightly sync re-fetches them; accounts, workspaces, billing, settings, consent
# records and connections (encrypted tokens) are kept. See docs/runbooks/backup-restore.md.
#
# pg_dump (custom format) of DATABASE_OWNER_URL → AES-256 (openssl, PBKDF2) with BACKUP_PASSPHRASE → BACKUP_DEST.
# Writes <name>.dump.enc and <name>.json (time, sha256, exact row counts taken in the dump's own snapshot).
#   BACKUP_DEST=s3://<bucket>/<prefix>  (Cloudflare R2: also R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY)
#   BACKUP_DEST=/path/to/dir            (local directory; used by infra/backup/test-backup.sh)
# Reads /opt/pinpulse/.env (or ENV_FILE). Usage: infra/backup/backup.sh
set -euo pipefail
ENV_FILE="${ENV_FILE:-$(dirname "$0")/../.env}"
getenv() { [ -n "${!1:-}" ] && { echo "${!1}"; return; }; grep -E "^$1=" "$ENV_FILE" 2>/dev/null | tail -n 1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//'; }
DB="$(getenv DATABASE_OWNER_URL)"; PASS="$(getenv BACKUP_PASSPHRASE)"; DEST="$(getenv BACKUP_DEST)"
[ -n "$DB" ] && [ -n "$DEST" ] || { echo "DATABASE_OWNER_URL and BACKUP_DEST are required"; exit 1; }
[ "${#PASS}" -ge 32 ] || { echo "BACKUP_PASSPHRASE must be 32+ characters (openssl rand -base64 32)"; exit 1; }
PG_IMAGE="${PG_IMAGE:-postgres:16}"

# Pinterest data tables (and their monthly partitions) → schema only (psql patterns: * is any text).
mapfile -t PDATA < <(grep -vE '^[[:space:]]*(#|$)' "$(dirname "$0")/pinterest-data-tables.txt")
[ "${#PDATA[@]}" -gt 0 ] || { echo "pinterest-data-tables.txt is empty; refusing to back up Pinterest data"; exit 1; }
EXCL=""; for t in "${PDATA[@]}"; do EXCL="$EXCL --exclude-table-data=public.$t --exclude-table-data=public.${t}_[0-9]*"; done

# Taken BEFORE the snapshot: restore re-applies every purge requested at or after this time (a superset is harmless).
STARTED="$(date -u +%FT%TZ)"
NAME="pinpulse-$(date -u -d "$STARTED" +%Y%m%dT%H%M%SZ)"
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
chmod 700 "$WORK"

# One container: export a snapshot, count rows in it, dump exactly that snapshot, encrypt before anything touches disk.
docker run --rm --network host -e DB="$DB" -e PASS="$PASS" -e EXCL="$EXCL" -v "$WORK:/out" "$PG_IMAGE" bash -euo pipefail -c '
  coproc PSQL { psql "$DB" -qAtX -v ON_ERROR_STOP=1; }
  echo "BEGIN ISOLATION LEVEL REPEATABLE READ; SELECT pg_export_snapshot();" >&"${PSQL[1]}"
  read -r SNAP <&"${PSQL[0]}"
  psql "$DB" -qAtX -v ON_ERROR_STOP=1 -c "BEGIN ISOLATION LEVEL REPEATABLE READ; SET TRANSACTION SNAPSHOT '"'"'$SNAP'"'"';
    SELECT json_object_agg(t, n) FROM (SELECT c.relname AS t,
      (xpath('"'"'/row/n/text()'"'"', query_to_xml(format('"'"'SELECT count(*) AS n FROM ONLY %I.%I'"'"', n.nspname, c.relname), false, true, '"'"''"'"')))[1]::text::bigint AS n
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('"'"'r'"'"') AND n.nspname = '"'"'public'"'"' ORDER BY 1) s; COMMIT;" > /out/counts.json
  pg_dump --format=custom $EXCL --snapshot="$SNAP" "$DB" \
    | openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -pass env:PASS -out /out/dump.enc
  echo "COMMIT;" >&"${PSQL[1]}"; exec {PSQL[1]}>&-; wait
'
SHA="$(sha256sum "$WORK/dump.enc" | cut -d' ' -f1)"
# Manifest: excluded tables count 0 rows (their data is not in the dump); restore checks they come back empty.
python3 - "$WORK/counts.json" "$WORK/manifest.json" "$NAME" "$STARTED" "$SHA" "$(stat -c %s "$WORK/dump.enc")" "${PDATA[@]}" <<'PY'
import json, re, sys
counts_f, out, name, started, sha, size, *excl = sys.argv[1:]
rx = re.compile(r"^(%s)(_[0-9]+)?$" % "|".join(map(re.escape, excl)))
counts = {t: (0 if rx.match(t) else n) for t, n in json.load(open(counts_f)).items()}
json.dump({"name": name, "created_at": started, "sha256": sha, "bytes": int(size), "excluded_data": excl, "row_counts": counts},
          open(out, "w"), separators=(",", ":"))
PY

case "$DEST" in
  s3://*)
    ACC="$(getenv R2_ACCOUNT_ID)"
    for f in dump.enc:"$NAME.dump.enc" manifest.json:"$NAME.json"; do
      docker run --rm -e AWS_ACCESS_KEY_ID="$(getenv R2_ACCESS_KEY_ID)" -e AWS_SECRET_ACCESS_KEY="$(getenv R2_SECRET_ACCESS_KEY)" \
        -e AWS_DEFAULT_REGION=auto -v "$WORK:/w:ro" amazon/aws-cli:2.27.0 \
        s3 cp "/w/${f%%:*}" "${DEST%/}/${f#*:}" --endpoint-url "https://$ACC.r2.cloudflarestorage.com" --only-show-errors
    done ;;
  *) mkdir -p "$DEST" && cp "$WORK/dump.enc" "$DEST/$NAME.dump.enc" && cp "$WORK/manifest.json" "$DEST/$NAME.json" ;;
esac
echo "backup $NAME ($SHA) → $DEST"
