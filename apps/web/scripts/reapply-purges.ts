/**
 * After restoring a backup (infra/backup/restore.sh, SPEC-074): connections purged in the LIVE database after the
 * backup was taken must be purged again in the restored copy, so "disconnect = delete" (CLAUDE.md non-negotiable 3)
 * survives a restore. Reads the live deletion_log (SOURCE_OWNER_URL) and runs the normal purge against DATABASE_URL.
 *   SOURCE_OWNER_URL=... DATABASE_URL=<restored, app role> tsx scripts/reapply-purges.ts --since <ISO time>
 */
import { parseArgs } from "node:util";
import postgres from "postgres";
import { closeDb, withWorkspace } from "@/lib/db";
import { assertPurged, purgeConnection } from "@/modules/privacy/purge";

const { values } = parseArgs({ options: { since: { type: "string" } } });
const since = values.since ? new Date(values.since) : null;
if (!since || Number.isNaN(since.getTime()) || !process.env.SOURCE_OWNER_URL) {
  console.error("usage: SOURCE_OWNER_URL=... DATABASE_URL=... reapply-purges.ts --since <ISO time>");
  process.exit(2);
}
const live = postgres(process.env.SOURCE_OWNER_URL, { max: 1, onnotice: () => {} });
// Everything deleted or disconnected since the backup: completed purges and ones still pending.
const rows = await live<{ connection_id: string; workspace_id: string }[]>`
  SELECT DISTINCT connection_id, workspace_id FROM deletion_log WHERE requested_at >= ${since} OR completed_at >= ${since}`;
await live.end();
for (const r of rows) {
  // In the restored copy the connection may still be active (it was disconnected after the backup): destroy its tokens
  // and mark it disconnected exactly as disconnect() does, then run the normal purge. Connections created after the
  // backup do not exist in the copy; purgeConnection then does nothing.
  await withWorkspace(r.workspace_id, (tx) => tx`
    UPDATE pinterest_connection SET status = 'disconnected', access_token_ct = NULL, refresh_token_ct = NULL, wrapped_key = NULL
    WHERE id = ${r.connection_id} AND status <> 'purged'`);
  await purgeConnection(r.workspace_id, r.connection_id);
}
const left = (await assertPurged()).filter((x) => rows.some((r) => r.connection_id === x.connectionId));
await closeDb();
if (left.length) {
  console.error(`purge re-apply incomplete for ${left.length} connection(s)`);
  process.exit(1);
}
console.log(`re-applied ${rows.length} purge(s) recorded since ${since.toISOString()}`);
