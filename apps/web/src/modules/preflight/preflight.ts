import { withWorkspace } from "@/lib/db";
import { analytics } from "@/modules/health/analytics-client";

export interface DraftRow { title: string; description: string; link: string; board: string; scheduled_at: string | null; image_ref: string | null }

/** Pre-flight: parse a drafts CSV and check it against rules labelled official / vendor / hypothesis (policy: PA-04). Nothing is stored. */
export async function preflightCsv(workspaceId: string, connectionId: string | null, csv: string, now = new Date()) {
  const parsed = await analytics.parseCsv<DraftRow>(csv, "pin_drafts");
  const history = connectionId
    ? await withWorkspace(workspaceId, (tx) => tx<{ link: string; created_at: string }[]>`
        SELECT link, to_char(pin_created_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at FROM pin_meta
        WHERE connection_id = ${connectionId} AND link IS NOT NULL AND pin_created_at > now() - interval '30 days'`)
    : [];
  const res = await analytics.preflight(parsed.rows, history.length ? history : null, now.toISOString());
  return { drafts: parsed.rows, warnings: parsed.warnings, findings: res.findings };
}
