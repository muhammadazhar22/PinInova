import { lockConnection } from "@/modules/pinterest/guard";
import { audit } from "@/lib/audit";
import { withWorkspace } from "@/lib/db";
import { analytics, type DiagnoseResponse } from "@/modules/health/analytics-client";

interface Row { date: string; impressions: number | null; outbound_clicks: number | null; pin_clicks: number | null; saves: number | null }

/**
 * Import the user's own Pinterest Analytics CSV export (up to ~1.5 years). This is the backfill path
 * and the fallback if PA-01 is answered "no". Column names of the native export are an unverified assumption;
 * the parser matches aliases and reports which columns it used.
 */
export async function importAnalyticsCsv(workspaceId: string, connectionId: string, actor: string, csv: string) {
  const parsed = await analytics.parseCsv<Row>(csv, "pinterest_analytics");
  const rows = parsed.rows.filter((r) => r.date);
  if (!rows.length) throw new Error("No dated rows found in the CSV");
  await withWorkspace(workspaceId, async (tx) => {
    await lockConnection(tx, connectionId);
    await tx`SELECT ensure_month_partitions(${rows[0]!.date}::date, ${rows.at(-1)!.date}::date)`;
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500).map((r) => ({
        workspace_id: workspaceId, connection_id: connectionId, date: r.date, split_key: "all", source: "csv",
        impressions: r.impressions, outbound_clicks: r.outbound_clicks, pin_clicks: r.pin_clicks, saves: r.saves,
      }));
      await tx`INSERT INTO account_metrics_daily ${tx(chunk, "workspace_id", "connection_id", "date", "split_key", "source", "impressions", "outbound_clicks", "pin_clicks", "saves")}
        ON CONFLICT (connection_id, date, split_key, source) DO UPDATE SET impressions = EXCLUDED.impressions, outbound_clicks = EXCLUDED.outbound_clicks,
          pin_clicks = EXCLUDED.pin_clicks, saves = EXCLUDED.saves, fetched_at = now()`;
    }
    await audit(tx, { workspaceId, actor, action: "import.analytics_csv", target: connectionId, detail: { rows: rows.length, range: parsed.date_range, columns: parsed.columns_matched } });
  });
  return { rows: rows.length, range: parsed.date_range, warnings: parsed.warnings, columns: parsed.columns_matched };
}

/** v0 Drop Check: analyse a CSV without an account and without storing anything. */
export async function dropCheck(csv: string): Promise<{ result: DiagnoseResponse; rows: Row[]; warnings: string[]; columns: Record<string, string> }> {
  const parsed = await analytics.parseCsv<Row>(csv, "pinterest_analytics");
  const rows = parsed.rows.filter((r) => r.date).sort((a, b) => a.date.localeCompare(b.date));
  if (rows.length < 14) throw new Error("Need at least 14 days of data. Export a longer date range from Pinterest Analytics.");
  const result = await analytics.diagnose({
    dates: rows.map((r) => r.date),
    impressions: rows.map((r) => r.impressions ?? 0),
    outbound_clicks: rows.map((r) => r.outbound_clicks ?? 0),
    saves: rows.map((r) => r.saves ?? 0),
    pin_clicks: rows.map((r) => r.pin_clicks ?? 0),
    provisional_days: 0,
  });
  return { result, rows, warnings: parsed.warnings, columns: parsed.columns_matched };
}
