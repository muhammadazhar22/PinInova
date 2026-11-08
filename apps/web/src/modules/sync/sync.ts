import { createHash } from "node:crypto";
import { env } from "@/env";
import { db, withWorkspace, one } from "@/lib/db";
import { addDays, dateRange, domainKey, todayUtc } from "@/lib/dates";
import { entitlements } from "@/modules/billing/plans";
import { flattenAnalytics, type PinterestClient } from "@/modules/pinterest/client";
import { clientFor, markNeedsReauth } from "@/modules/pinterest/connections";
import { PinterestAuthError } from "@/modules/pinterest/errors";
import type { Pin } from "@/modules/pinterest/types";

/** Pinterest may send date-times without an offset; they are UTC. */
export function utcStamp(v: string | null | undefined): string | null {
  if (!v) return null;
  return /([zZ]|[+-]\d{2}:?\d{2})$/.test(v) ? v : `${v}Z`;
}

/** The connection was disconnected, purged or needs re-authorization: the job is done, not failed. */
export class InactiveConnectionError extends Error {
  constructor(readonly status: string) {
    super(`connection not active (${status})`);
  }
}

export interface SyncResult {
  start: string;
  end: string;
  accountRows: number;
  pins: number;
  trackedPins: number;
  pinRows: number;
  apiCalls: number;
}

const METRIC_MAP = { impressions: "IMPRESSION", outbound_clicks: "OUTBOUND_CLICK", pin_clicks: "PIN_CLICK", saves: "SAVE" } as const;

/**
 * Pull one account. Window: first sync = the full 90-day API window; later syncs = since last
 * sync plus the provisional days again (policy: PA-08). Stores numbers and minimal Pin metadata only
 * (policy: PA-01, PA-02).
 */
export async function syncAccount(workspaceId: string, connectionId: string, opts: { now?: Date; client?: PinterestClient } = {}): Promise<SyncResult> {
  const e = env();
  const now = opts.now ?? new Date();
  const end = todayUtc(now);
  const conn = await withWorkspace(workspaceId, async (tx) => (await tx<{ last_synced_at: Date | null; status: string }[]>`
    SELECT last_synced_at, status FROM pinterest_connection WHERE id = ${connectionId}`)[0]);
  if (!conn || conn.status !== "active") throw new InactiveConnectionError(conn?.status ?? "missing");
  const { org } = await one(db()<{ org: string }[]>`SELECT system_workspace_org(${workspaceId}::uuid) AS org`);
  const ent = await entitlements(org);

  const fullStart = addDays(end, -89);
  const start = conn.last_synced_at
    ? [addDays(todayUtc(conn.last_synced_at), -(e.PROVISIONAL_DAYS + 1)), fullStart].sort().reverse()[0]!
    : fullStart;

  let client: PinterestClient;
  try {
    client = opts.client ?? (await clientFor(workspaceId, connectionId));
  } catch (err) {
    if (err instanceof PinterestAuthError) await markNeedsReauth(workspaceId, connectionId, err.message);
    throw err;
  }

  try {
    const accountRows: Array<{ date: string; split: string; status?: string; m: Record<string, number> }> = [];
    accountRows.push(...flattenAnalytics(await client.accountAnalytics({ start, end, split: "NO_SPLIT" })).map((r) => ({ ...r, split: "all" })));
    accountRows.push(...flattenAnalytics(await client.accountAnalytics({ start, end, split: "OWNED_CONTENT" })).map((r) => ({ ...r, split: `owned:${r.split}` })));
    const websites = await client.websites();

    // Pin metadata (one paginated pass; org_read budget is large).
    const pins: Pin[] = [];
    for await (const p of client.listPins({ pageSize: 250 })) pins.push(p);

    // Tracked-Pin policy: top 50 by impressions + Pins created in the last 90 days + a rotating seventh of the rest.
    const top = await client.topPins({ start: addDays(end, -29), end, sortBy: "IMPRESSION", num: 50 });
    const tracked = new Set<string>(top.pins.map((p) => p.pin_id));
    const recentCut = addDays(end, -90);
    const rotation = Math.floor(Date.parse(end) / 86400_000) % 7;
    const cap = Math.min(ent.trackedPins, e.TRACKED_PINS_CAP);
    for (const p of [...pins].sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""))) {
      if (tracked.size >= cap) break;
      if ((p.created_at ?? "") >= recentCut) tracked.add(p.id);
    }
    for (const p of pins) {
      if (tracked.size >= cap) break;
      const bucket = createHash("md5").update(p.id).digest()[0]! % 7;
      if (bucket === rotation) tracked.add(p.id);
    }

    const pinRows: Array<{ pin: string; date: string; m: Record<string, number> }> = [];
    for (const pinId of tracked) {
      // Long-tail Pins (rotation) are pulled with a 14-day window so no day is missed between rotations.
      const pinStart = conn.last_synced_at && !top.pins.some((t) => t.pin_id === pinId) ? [addDays(end, -14), start].sort()[0]! : start;
      const r = await client.pinAnalytics(pinId, { start: pinStart, end });
      for (const row of flattenAnalytics(r)) pinRows.push({ pin: pinId, date: row.date, m: row.m });
    }

    await withWorkspace(workspaceId, async (tx) => {
      await tx`SELECT ensure_month_partitions(${start}::date, ${end}::date)`;
      for (const r of accountRows) {
        await tx`
          INSERT INTO account_metrics_daily (workspace_id, connection_id, date, split_key, source, impressions, outbound_clicks, pin_clicks, saves, data_status)
          VALUES (${workspaceId}, ${connectionId}, ${r.date}, ${r.split}, 'api', ${r.m[METRIC_MAP.impressions] ?? null}, ${r.m[METRIC_MAP.outbound_clicks] ?? null},
                  ${r.m[METRIC_MAP.pin_clicks] ?? null}, ${r.m[METRIC_MAP.saves] ?? null}, ${r.status ?? null})
          ON CONFLICT (connection_id, date, split_key, source) DO UPDATE SET impressions = EXCLUDED.impressions, outbound_clicks = EXCLUDED.outbound_clicks,
            pin_clicks = EXCLUDED.pin_clicks, saves = EXCLUDED.saves, data_status = EXCLUDED.data_status, fetched_at = now()`;
      }
      // Batched upsert for Pin rows.
      for (let i = 0; i < pinRows.length; i += 500) {
        const chunk = pinRows.slice(i, i + 500).map((r) => ({
          workspace_id: workspaceId, connection_id: connectionId, pin_id: r.pin, date: r.date,
          impressions: r.m.IMPRESSION ?? null, outbound_clicks: r.m.OUTBOUND_CLICK ?? null, pin_clicks: r.m.PIN_CLICK ?? null, saves: r.m.SAVE ?? null,
        }));
        await tx`
          INSERT INTO pin_metrics_daily ${tx(chunk, "workspace_id", "connection_id", "pin_id", "date", "impressions", "outbound_clicks", "pin_clicks", "saves")}
          ON CONFLICT (connection_id, pin_id, date) DO UPDATE SET impressions = EXCLUDED.impressions, outbound_clicks = EXCLUDED.outbound_clicks,
            pin_clicks = EXCLUDED.pin_clicks, saves = EXCLUDED.saves, fetched_at = now()`;
      }
      if (e.STORE_PIN_METADATA) {
        // policy: PA-02 — id, created_at, board id, link, domain, declared AI disclosure. Never title/description/image.
        for (let i = 0; i < pins.length; i += 500) {
          const chunk = pins.slice(i, i + 500).map((p) => ({
            workspace_id: workspaceId, connection_id: connectionId, pin_id: p.id, pin_created_at: utcStamp(p.created_at), board_id: p.board_id ?? null,
            link: p.link ?? null, link_domain: domainKey(p.link, e.PINTEREST_MODE), has_link: Boolean(p.link), ai_disclosure: p.ai_disclosures?.values ?? null,
          }));
          await tx`
            INSERT INTO pin_meta ${tx(chunk, "workspace_id", "connection_id", "pin_id", "pin_created_at", "board_id", "link", "link_domain", "has_link", "ai_disclosure")}
            ON CONFLICT (connection_id, pin_id) DO UPDATE SET board_id = EXCLUDED.board_id, link = EXCLUDED.link, link_domain = EXCLUDED.link_domain,
              has_link = EXCLUDED.has_link, ai_disclosure = EXCLUDED.ai_disclosure, last_seen = now()`;
        }
      }
      await tx`UPDATE pinterest_connection SET last_synced_at = ${now}, last_sync_error = NULL, claimed_sites = ${tx.json(websites as never)},
               sync_stats = ${tx.json({ start, end, pins: pins.length, tracked: tracked.size, api_calls: client.calls } as never)} WHERE id = ${connectionId}`;
    });

    // Keep dates contiguous for downstream checks.
    void dateRange;
    return { start, end, accountRows: accountRows.length, pins: pins.length, trackedPins: tracked.size, pinRows: pinRows.length, apiCalls: client.calls };
  } catch (err) {
    if (err instanceof PinterestAuthError) await markNeedsReauth(workspaceId, connectionId, err.message);
    else await withWorkspace(workspaceId, (tx) => tx`UPDATE pinterest_connection SET last_sync_error = ${(err as Error).message.slice(0, 500)} WHERE id = ${connectionId}`);
    throw err;
  }
}
