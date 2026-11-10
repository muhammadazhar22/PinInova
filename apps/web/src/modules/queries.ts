import { num, type Tx } from "@/lib/db";
import { addDays, dateRange, todayUtc } from "@/lib/dates";
import type { DiagnoseResponse } from "@/modules/health/analytics-client";

export interface ConnectionSummary {
  id: string;
  username: string;
  status: string;
  mode: string;
  last_synced_at: Date | null;
  last_sync_error: string | null;
  score: number | null;
  open_incidents: number;
  top_cause: string | null;
  open_issues: number;
}

export async function workspaceOverview(tx: Tx) {
  const [ws] = await tx<{ id: string; name: string; kind: string; niche: string | null }[]>`SELECT id, name, kind, niche FROM workspace WHERE id = app_workspace_id()`;
  const conns = await tx<ConnectionSummary[]>`
    SELECT c.id, c.username, c.status, c.mode, c.last_synced_at, c.last_sync_error,
      (SELECT score FROM health_snapshot h WHERE h.connection_id = c.id ORDER BY date DESC LIMIT 1) AS score,
      (SELECT count(*)::int FROM incident i WHERE i.connection_id = c.id AND i.state = 'open') AS open_incidents,
      (SELECT top_cause FROM incident i WHERE i.connection_id = c.id AND i.state = 'open' ORDER BY detected_at DESC LIMIT 1) AS top_cause,
      (SELECT count(*)::int FROM issue s WHERE s.connection_id = c.id AND s.state IN ('open','regressed')) AS open_issues
    FROM pinterest_connection c WHERE c.status <> 'purged' ORDER BY c.created_at`;
  const consentLinks = await tx<{ id: string; client_email: string | null; expires_at: Date; used_at: Date | null; created_at: Date }[]>`
    SELECT id, client_email, expires_at, used_at, created_at FROM consent_request ORDER BY created_at DESC LIMIT 10`;
  return { ws: ws!, conns, consentLinks };
}

export async function accountDetail(tx: Tx, connectionId: string) {
  const [conn] = await tx<{ id: string; username: string; status: string; mode: string; last_synced_at: Date | null; last_sync_error: string | null; claimed_sites: { website?: string; status?: string }[]; sync_stats: Record<string, unknown>; created_at: Date }[]>`
    SELECT id, username, status, mode, last_synced_at, last_sync_error, claimed_sites, sync_stats, created_at FROM pinterest_connection WHERE id = ${connectionId}`;
  if (!conn) return null;
  const end = todayUtc();
  const start = addDays(end, -89);
  const rows = await tx<{ date: string; impressions: bigint | null; outbound_clicks: bigint | null; saves: bigint | null; data_status: string | null }[]>`
    SELECT DISTINCT ON (date) to_char(date,'YYYY-MM-DD') AS date, impressions, outbound_clicks, saves, data_status FROM account_metrics_daily
    WHERE connection_id = ${connectionId} AND split_key = 'all' AND date BETWEEN ${start} AND ${end}
    ORDER BY date, CASE source WHEN 'api' THEN 0 ELSE 1 END`;
  const by = new Map(rows.map((r) => [r.date, r]));
  const firstDate = rows[0]?.date ?? start;
  const dates = dateRange(firstDate, rows.at(-1)?.date ?? end);
  const series = {
    dates,
    impressions: dates.map((d) => (by.has(d) ? num(by.get(d)!.impressions) : null)),
    clicks: dates.map((d) => (by.has(d) ? num(by.get(d)!.outbound_clicks) : null)),
    saves: dates.map((d) => (by.has(d) ? num(by.get(d)!.saves) : null)),
    provisional: dates.filter((d) => by.get(d)?.data_status && by.get(d)!.data_status !== "READY"),
  };
  const [health] = await tx<{ score: number; band: string; subgrades: Record<string, number | null>; date: string }[]>`
    SELECT score, band, subgrades, to_char(date,'YYYY-MM-DD') AS date FROM health_snapshot WHERE connection_id = ${connectionId} ORDER BY date DESC LIMIT 1`;
  const incidents = await tx<{ id: string; status: string; tier: string; onset_date: string | null; warning_date: string | null; effect: number | null; top_cause: string | null; confidence: string | null; state: string; detected_at: Date; result: DiagnoseResponse; q_value: number | null }[]>`
    SELECT id, status, tier, to_char(onset_date,'YYYY-MM-DD') AS onset_date, to_char(warning_date,'YYYY-MM-DD') AS warning_date, effect, top_cause, confidence, state, detected_at, result, q_value
    FROM incident WHERE connection_id = ${connectionId} ORDER BY detected_at DESC LIMIT 20`;
  const issues = await tx<{ id: string; kind: string; source: string; severity: string; title: string; detail: Record<string, unknown>; affected_count: number; state: string; first_seen: Date; last_seen: Date }[]>`
    SELECT id, kind, source, severity, title, detail, affected_count, state, first_seen, last_seen FROM issue WHERE connection_id = ${connectionId}
    ORDER BY CASE state WHEN 'regressed' THEN 0 WHEN 'open' THEN 1 WHEN 'validating' THEN 2 ELSE 3 END, CASE severity WHEN 'error' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, last_seen DESC`;
  const observed = await tx<{ id: string; kind: string; note: string | null; observed_on: string }[]>`
    SELECT id, kind, note, to_char(observed_on,'YYYY-MM-DD') AS observed_on FROM observed_signal WHERE connection_id = ${connectionId} ORDER BY observed_on DESC LIMIT 20`;
  const checks = await tx<{ url: string; domain: string; http_status: number | null; total_ms: number | null; hops: unknown[]; robots: { blocked?: boolean; crawlDelay?: number | null; found?: boolean } | null; title_match: boolean | null; claimed: boolean | null; error: string | null; checked_at: Date }[]>`
    SELECT url, domain, http_status, total_ms, hops, robots, title_match, claimed, error, checked_at FROM check_result WHERE connection_id = ${connectionId}
      AND run_id = (SELECT run_id FROM check_result WHERE connection_id = ${connectionId} ORDER BY checked_at DESC LIMIT 1) ORDER BY domain, url`;
  return { conn, series, health: health ?? null, incidents, issues, observed, checks };
}

export async function incidentDetail(tx: Tx, incidentId: string) {
  const [i] = await tx<{ id: string; connection_id: string; status: string; tier: string; onset_date: string | null; warning_date: string | null; state: string; result: DiagnoseResponse; detected_at: Date; q_value: number | null; user_cause: string | null; detector_version: string }[]>`
    SELECT id, connection_id, status, tier, to_char(onset_date,'YYYY-MM-DD') AS onset_date, to_char(warning_date,'YYYY-MM-DD') AS warning_date, state, result, detected_at, q_value, user_cause, detector_version
    FROM incident WHERE id = ${incidentId}`;
  if (!i) return null;
  const reports = await tx<{ id: string; created_at: Date }[]>`SELECT id, created_at FROM report WHERE incident_id = ${incidentId} ORDER BY created_at DESC`;
  return { incident: i, reports };
}

export async function reportsList(tx: Tx) {
  return tx<{ id: string; kind: string; period_start: string | null; period_end: string | null; username: string; created_at: Date; has_pdf: boolean; shared: boolean; share_expires_at: Date | null }[]>`
    SELECT r.id, r.kind, to_char(r.period_start,'YYYY-MM-DD') AS period_start, to_char(r.period_end,'YYYY-MM-DD') AS period_end, c.username, r.created_at,
      r.pdf IS NOT NULL AS has_pdf, r.share_token_hash IS NOT NULL AS shared, r.share_expires_at
    FROM report r JOIN pinterest_connection c ON c.id = r.connection_id ORDER BY r.created_at DESC LIMIT 50`;
}

export async function alertSettingsAndHistory(tx: Tx) {
  const [s] = await tx<{ sensitivity: number; emails: string[]; slack_webhook_ct: Buffer | null; digest: string }[]>`
    SELECT sensitivity, emails, slack_webhook_ct, digest FROM alert_settings WHERE workspace_id = app_workspace_id()`;
  const history = await tx<{ id: string; tier: string; channel: string; title: string; created_at: Date; delivered_at: Date | null; delivery_error: string | null; useful: boolean | null }[]>`
    SELECT id, tier, channel, title, created_at, delivered_at, delivery_error, useful FROM alert ORDER BY created_at DESC LIMIT 50`;
  const outbox = await tx<{ id: string; to_address: string; subject: string; created_at: Date; sent_at: Date | null; transport: string }[]>`
    SELECT id, to_address, subject, created_at, sent_at, transport FROM email_outbox ORDER BY created_at DESC LIMIT 20`;
  return { settings: s ? { sensitivity: s.sensitivity, emails: s.emails, slack: Boolean(s.slack_webhook_ct), digest: s.digest } : { sensitivity: 0.5, emails: [], slack: false, digest: "immediate" }, history, outbox };
}

export async function settingsData(tx: Tx) {
  const consents = await tx<{ id: string; pinterest_username: string; scopes: string[]; consent_text_version: string; granted_via: string; granted_at: Date; revoked_at: Date | null }[]>`
    SELECT id, pinterest_username, scopes, consent_text_version, granted_via, granted_at, revoked_at FROM consent_record ORDER BY granted_at DESC`;
  const viewers = await tx<{ user_id: string; email: string; created_at: Date }[]>`
    SELECT a.user_id, u.email, a.created_at FROM workspace_access a JOIN "user" u ON u.id = a.user_id ORDER BY a.created_at`;
  const auditLog = await tx<{ id: bigint; actor: string; action: string; target: string | null; at: Date }[]>`
    SELECT id, actor, action, target, at FROM audit_event WHERE workspace_id = app_workspace_id() ORDER BY at DESC LIMIT 100`;
  const deletions = await tx<{ connection_id: string; reason: string; requested_at: Date; completed_at: Date | null; rows_deleted: Record<string, number> | null }[]>`
    SELECT connection_id, reason, requested_at, completed_at, rows_deleted FROM deletion_log ORDER BY requested_at DESC LIMIT 20`;
  return { consents, viewers, auditLog, deletions };
}

export async function attributionData(tx: Tx, connectionId: string) {
  const leaks = await tx<{ id: string; source: string; period_start: string; period_end: string; pinterest_outbound_clicks: bigint | null; ga4_pinterest_sessions: bigint | null; ga4_direct_sessions: bigint | null; leak_ratio: number | null; detail: Record<string, unknown>; created_at: Date }[]>`
    SELECT id, source, to_char(period_start,'YYYY-MM-DD') AS period_start, to_char(period_end,'YYYY-MM-DD') AS period_end, pinterest_outbound_clicks, ga4_pinterest_sessions, ga4_direct_sessions, leak_ratio, detail, created_at
    FROM traffic_leak_result WHERE connection_id = ${connectionId} ORDER BY created_at DESC LIMIT 5`;
  const links = await tx<{ link: string }[]>`SELECT DISTINCT link FROM pin_meta WHERE connection_id = ${connectionId} AND link IS NOT NULL ORDER BY link LIMIT 50`;
  return { leaks, links: links.map((l) => l.link) };
}

/** GDPR portability: everything PinInova holds for this workspace (no tokens). */
export async function exportWorkspace(tx: Tx) {
  const q = (t: string) => tx.unsafe(`SELECT * FROM ${t} WHERE workspace_id = app_workspace_id()`);
  const conns = await tx`SELECT id, mode, pinterest_user_id, username, account_type, scopes, status, created_at, disconnected_at, last_synced_at, claimed_sites FROM pinterest_connection`;
  const out: Record<string, unknown> = { exported_at: new Date().toISOString(), connections: conns };
  for (const t of ["consent_record", "account_metrics_daily", "pin_metrics_daily", "pin_meta", "incident", "issue", "check_result", "health_snapshot", "alert", "traffic_leak_result", "pin_token", "observed_signal"]) {
    out[t] = await q(t);
  }
  return out;
}
