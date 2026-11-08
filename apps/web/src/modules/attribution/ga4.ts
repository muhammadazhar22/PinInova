import { env } from "@/env";
import { audit } from "@/lib/audit";
import { num, one, withWorkspace } from "@/lib/db";
import { addDays, dateRange } from "@/lib/dates";
import { analytics } from "@/modules/health/analytics-client";

/**
 * GA4 Traffic Leak Check. NOT production-ready (docs/INTEGRATIONS.md): the GA4 Data API client is a
 * mock; the supported path is a CSV export from GA4 (Reports › Acquisition › Traffic acquisition with
 * Session source / medium and Landing page). Detects Pinterest traffic that GA4 files as "Direct"
 * (iOS app referrals since June 2025) by comparing Pinterest's outbound clicks with GA4 sessions.
 */
interface Ga4Row { date: string; source: string; medium: string; landing_page: string | null; sessions: number }

export interface LeakResult {
  periodStart: string;
  periodEnd: string;
  pinterestOutboundClicks: number;
  ga4PinterestSessions: number;
  ga4DirectSessionsOnPinPages: number;
  leakRatio: number;
  sessionsPerClick: number | null;
  autoUtmSeen: boolean;
  source: "csv" | "mock";
}

export function computeLeak(rows: Ga4Row[], pinPaths: Set<string>, outboundClicks: number, source: "csv" | "mock"): LeakResult {
  const dates = rows.map((r) => r.date).sort();
  const isPin = (r: Ga4Row) => /pinterest/i.test(r.source);
  const pinterest = rows.filter(isPin).reduce((a, r) => a + r.sessions, 0);
  const direct = rows
    .filter((r) => /^\(direct\)$/i.test(r.source) && r.landing_page && pinPaths.has(normPath(r.landing_page)))
    .reduce((a, r) => a + r.sessions, 0);
  const autoUtm = rows.some((r) => isPin(r) && /^organic$/i.test(r.medium));
  return {
    periodStart: dates[0] ?? "",
    periodEnd: dates.at(-1) ?? "",
    pinterestOutboundClicks: outboundClicks,
    ga4PinterestSessions: pinterest,
    ga4DirectSessionsOnPinPages: direct,
    leakRatio: pinterest + direct > 0 ? direct / (pinterest + direct) : 0,
    sessionsPerClick: outboundClicks > 0 ? (pinterest + direct) / outboundClicks : null,
    autoUtmSeen: autoUtm,
    source,
  };
}

export function normPath(p: string): string {
  try {
    const u = new URL(p, "https://x.invalid");
    return u.pathname.replace(/\/+$/, "") || "/";
  } catch {
    return p;
  }
}

async function pinPathsAndClicks(workspaceId: string, connectionId: string, start: string, end: string) {
  return withWorkspace(workspaceId, async (tx) => {
    const links = await tx<{ link: string }[]>`SELECT DISTINCT link FROM pin_meta WHERE connection_id = ${connectionId} AND link IS NOT NULL`;
    const paths = new Set(links.map((l) => normPath(l.link)));
    // Mock sites put the "domain" in the first path segment; also index the path without it.
    if (env().PINTEREST_MODE === "mock") for (const l of links) paths.add(normPath("/" + normPath(l.link).split("/").slice(2).join("/")));
    const { n } = await one(tx<{ n: bigint | null }[]>`
      SELECT sum(outbound_clicks) AS n FROM account_metrics_daily WHERE connection_id = ${connectionId} AND split_key = 'all' AND source = 'api'
      AND date BETWEEN ${start} AND ${end}`);
    return { paths, clicks: num(n) };
  });
}

export async function leakCheckFromCsv(workspaceId: string, connectionId: string, actor: string, csv: string) {
  const parsed = await analytics.parseCsv<Ga4Row>(csv, "ga4_sessions");
  if (!parsed.rows.length) throw new Error("No GA4 rows found");
  const [start, end] = parsed.date_range ?? [parsed.rows[0]!.date, parsed.rows.at(-1)!.date];
  const { paths, clicks } = await pinPathsAndClicks(workspaceId, connectionId, start, end);
  const r = computeLeak(parsed.rows, paths, clicks, "csv");
  await store(workspaceId, connectionId, actor, r, { warnings: parsed.warnings, columns: parsed.columns_matched });
  return r;
}

/** Mock GA4: synthesises a GA4 export consistent with the account's own clicks. Clearly labelled as simulated. */
export async function leakCheckMock(workspaceId: string, connectionId: string, actor: string, end: string) {
  const start = addDays(end, -27);
  const { paths, clicks } = await pinPathsAndClicks(workspaceId, connectionId, start, end);
  const sample = [...paths].slice(0, 5);
  const rows: Ga4Row[] = [];
  for (const d of dateRange(start, end)) {
    const daily = Math.round(clicks / 28);
    rows.push({ date: d, source: "pinterest", medium: "organic", landing_page: sample[0] ?? "/", sessions: Math.round(daily * 0.55) });
    rows.push({ date: d, source: "(direct)", medium: "(none)", landing_page: sample[1] ?? sample[0] ?? "/", sessions: Math.round(daily * 0.3) });
  }
  const r = computeLeak(rows, paths, clicks, "mock");
  await store(workspaceId, connectionId, actor, r, { simulated: true });
  return r;
}

async function store(workspaceId: string, connectionId: string, actor: string, r: LeakResult, detail: Record<string, unknown>) {
  await withWorkspace(workspaceId, async (tx) => {
    await tx`INSERT INTO traffic_leak_result (workspace_id, connection_id, source, period_start, period_end, pinterest_outbound_clicks, ga4_pinterest_sessions, ga4_direct_sessions, leak_ratio, detail)
             VALUES (${workspaceId}, ${connectionId}, ${r.source}, ${r.periodStart}, ${r.periodEnd}, ${r.pinterestOutboundClicks}, ${r.ga4PinterestSessions}, ${r.ga4DirectSessionsOnPinPages},
                     ${r.leakRatio}, ${tx.json({ ...detail, sessions_per_click: r.sessionsPerClick, auto_utm_seen: r.autoUtmSeen } as never)})`;
    await audit(tx, { workspaceId, actor, action: "attribution.leak_check", target: connectionId, detail: { source: r.source } });
  });
}
