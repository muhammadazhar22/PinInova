import { createHash } from "node:crypto";
import { env } from "@/env";
import { audit } from "@/lib/audit";
import { db, withWorkspace, one } from "@/lib/db";

export const PURGED_TABLES = [
  "account_metrics_daily", "pin_metrics_daily", "pin_meta", "alert", "incident", "issue", "check_result",
  "health_snapshot", "report", "traffic_leak_result", "pin_token", "order_attribution", "observed_signal", "email_outbox",
] as const;

/**
 * Hard-delete all Pinterest Data for a connection (Terms §4.4; design target 24 h).
 * The consent record is kept as proof of consent but its Pinterest identifiers are replaced by hashes.
 */
export async function purgeConnection(workspaceId: string, connectionId: string) {
  const counts: Record<string, number> = {};
  await withWorkspace(workspaceId, async (tx) => {
    const [c] = await tx<{ status: string; pinterest_user_id: string }[]>`SELECT status, pinterest_user_id FROM pinterest_connection WHERE id = ${connectionId} FOR UPDATE`;
    if (!c) return;
    if (c.status === "active") throw new Error("refusing to purge an active connection; disconnect first");
    for (const t of PURGED_TABLES) {
      if (t === "alert") {
        const r = await tx`DELETE FROM alert WHERE incident_id IN (SELECT id FROM incident WHERE connection_id = ${connectionId})
                                         OR issue_id IN (SELECT id FROM issue WHERE connection_id = ${connectionId})`;
        counts[t] = r.count;
        continue;
      }
      const r = await tx.unsafe(`DELETE FROM ${t} WHERE connection_id = $1`, [connectionId]);
      counts[t] = r.count;
    }
    const pseudo = createHash("sha256").update(`pinpulse:${c.pinterest_user_id}`).digest("hex").slice(0, 32);
    await tx`UPDATE consent_record SET pinterest_user_id = ${"sha256:" + pseudo}, pinterest_username = 'purged', revoke_token_hash = NULL,
             revoked_at = coalesce(revoked_at, now()) WHERE connection_id = ${connectionId}`;
    await tx`UPDATE pinterest_connection SET status = 'purged', purged_at = now(), username = 'purged', pinterest_user_id = ${"purged:" + connectionId},
             account_type = NULL, access_token_ct = NULL, refresh_token_ct = NULL, wrapped_key = NULL, last_sync_error = NULL
             WHERE id = ${connectionId}`;
    await tx`UPDATE deletion_log SET completed_at = now(), rows_deleted = ${tx.json(counts)} WHERE connection_id = ${connectionId} AND completed_at IS NULL`;
    await audit(tx, { workspaceId, actor: "system", action: "connection.purged", target: connectionId, detail: counts });
  });
  return counts;
}

/** Nightly assertion: purged connections must have zero rows left anywhere. */
export async function assertPurged(): Promise<{ connectionId: string; leftovers: Record<string, number> }[]> {
  const ids = await db()<{ connection_id: string }[]>`SELECT * FROM system_purged_connections()`;
  const bad: { connectionId: string; leftovers: Record<string, number> }[] = [];
  for (const { connection_id } of ids) {
    const { r } = await one(db()<{ r: Record<string, number> }[]>`SELECT system_rows_for_connection(${connection_id}) AS r`);
    const left = Object.fromEntries(Object.entries(r).filter(([, n]) => Number(n) > 0));
    if (Object.keys(left).length) bad.push({ connectionId: connection_id, leftovers: left });
  }
  return bad;
}

/** Retention (policy: PA-01). */
export async function runRetention(now = new Date()) {
  const e = env();
  const day = 86400_000;
  const rawCutoff = new Date(now.getTime() - e.RETENTION_RAW_DAYS * day).toISOString().slice(0, 10);
  const derivedCutoff = new Date(now.getTime() - e.RETENTION_DERIVED_DAYS * day);
  const { r: metrics } = await one(db()<{ r: unknown }[]>`SELECT system_delete_metrics_before(${rawCutoff}::date, ${derivedCutoff.toISOString().slice(0, 10)}::date) AS r`);
  const { r: derived } = await one(db()<{ r: unknown }[]>`SELECT system_delete_derived_before(${derivedCutoff}) AS r`);
  // Keep partitions rolling: create upcoming months, drop months entirely older than derived retention.
  await db()`SELECT ensure_month_partitions(current_date, (current_date + interval '3 months')::date)`;
  const { n: dropped } = await one(db()<{ n: number }[]>`SELECT system_drop_metric_partitions_before(${derivedCutoff.toISOString().slice(0, 10)}::date) AS n`);
  return { metrics, derived, droppedPartitions: dropped, rawCutoff };
}
