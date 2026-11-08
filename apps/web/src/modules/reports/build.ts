import { env } from "@/env";
import { audit } from "@/lib/audit";
import { num, one, withWorkspace, type Tx } from "@/lib/db";
import { addDays, dateRange, todayUtc } from "@/lib/dates";
import { hashToken, newToken } from "@/lib/tokens";
import { entitlements } from "@/modules/billing/plans";
import { CAUSE_LABELS, type DiagnoseResponse } from "@/modules/health/analytics-client";
import { escapeHtml as h } from "@/modules/notify/email";
import { lineChartSvg } from "./svg";

const CSS = `body{font-family:Inter,system-ui,sans-serif;color:#111827;margin:32px;font-size:13px;line-height:1.5}
h1{font-size:22px;margin:0 0 4px}h2{font-size:15px;margin:24px 0 8px;border-bottom:1px solid #e5e7eb;padding-bottom:4px}
.muted{color:#6b7280}.k{display:inline-block;margin-right:24px}.k b{display:block;font-size:20px;font-variant-numeric:tabular-nums}
table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}td,th{border-bottom:1px solid #f3f4f6;padding:4px 6px;text-align:left;vertical-align:top}
.chip{display:inline-block;padding:1px 8px;border-radius:999px;font-size:11px;border:1px solid #d1d5db}.foot{margin-top:32px;font-size:11px;color:#6b7280}
pre{white-space:pre-wrap;background:#f9fafb;border:1px solid #e5e7eb;padding:12px;font-size:12px}`;

interface Brand { name: string; color: string; footer: string }

async function brandFor(orgId: string, tx: Tx): Promise<Brand> {
  const ent = await entitlements(orgId, tx);
  const [o] = await tx<{ name: string; metadata: string | null }[]>`SELECT name, metadata FROM organization WHERE id = ${orgId}`;
  let color = "#0f766e";
  try {
    const m = JSON.parse(o?.metadata ?? "{}") as { brandColor?: string };
    if (m.brandColor && /^#[0-9a-f]{6}$/i.test(m.brandColor)) color = m.brandColor;
  } catch {
    /* default */
  }
  return ent.whiteLabel
    ? { name: o?.name ?? "", color, footer: `Prepared by ${o?.name ?? ""}.` }
    : { name: o?.name ?? "", color: "#0f766e", footer: "Prepared with PinPulse. PinPulse is not affiliated with Pinterest." };
}

async function series(tx: Tx, connectionId: string, start: string, end: string) {
  const rows = await tx<{ date: string; impressions: bigint | null; outbound_clicks: bigint | null; saves: bigint | null }[]>`
    SELECT DISTINCT ON (date) to_char(date,'YYYY-MM-DD') AS date, impressions, outbound_clicks, saves FROM account_metrics_daily
    WHERE connection_id = ${connectionId} AND split_key = 'all' AND date BETWEEN ${start} AND ${end}
    ORDER BY date, CASE source WHEN 'api' THEN 0 ELSE 1 END`;
  const by = new Map(rows.map((r) => [r.date, r]));
  const dates = dateRange(start, end);
  return {
    dates,
    impressions: dates.map((d) => num(by.get(d)?.impressions)),
    clicks: dates.map((d) => num(by.get(d)?.outbound_clicks)),
    saves: dates.map((d) => num(by.get(d)?.saves)),
  };
}

const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
const pct = (a: number, b: number) => (b > 0 ? `${a >= b ? "+" : ""}${Math.round(((a - b) / b) * 100)}%` : "–");

export async function buildMonthlyReport(workspaceId: string, orgId: string, connectionId: string, actor: string, now = new Date()) {
  return withWorkspace(workspaceId, async (tx) => {
    const end = addDays(todayUtc(now), -1);
    const start = addDays(end, -29);
    const prevStart = addDays(start, -30);
    const brand = await brandFor(orgId, tx);
    const conn = await one(tx<{ username: string }[]>`SELECT username FROM pinterest_connection WHERE id = ${connectionId}`);
    const [ws] = await tx<{ name: string }[]>`SELECT name FROM workspace WHERE id = ${workspaceId}`;
    const cur = await series(tx, connectionId, start, end);
    const prev = await series(tx, connectionId, prevStart, addDays(start, -1));
    const incidents = await tx<{ id: string; onset_date: string | null; status: string; tier: string; result: DiagnoseResponse; state: string }[]>`
      SELECT id, to_char(onset_date,'YYYY-MM-DD') AS onset_date, status, tier, result, state FROM incident
      WHERE connection_id = ${connectionId} AND detected_at >= ${prevStart} ORDER BY detected_at DESC`;
    const issues = await tx<{ title: string; source: string; severity: string; state: string; affected_count: number }[]>`
      SELECT title, source, severity, state, affected_count FROM issue WHERE connection_id = ${connectionId} AND state <> 'suppressed' ORDER BY severity, last_seen DESC`;
    const health = await tx<{ date: string; score: number }[]>`
      SELECT to_char(date,'YYYY-MM-DD') AS date, score FROM health_snapshot WHERE connection_id = ${connectionId} AND date >= ${start} ORDER BY date`;
    const markers = incidents.filter((i) => i.onset_date && i.onset_date >= start).map((i) => ({ date: i.onset_date!, label: i.status === "drop" ? "drop" : "warning" }));
    const chart = lineChartSvg({ dates: cur.dates, series: [{ name: "Impressions", values: cur.impressions, color: brand.color }], markers });
    const chart2 = lineChartSvg({ dates: cur.dates, series: [{ name: "Outbound clicks", values: cur.clicks, color: "#6b7280" }, { name: "Saves", values: cur.saves, color: "#a3a3a3" }], height: 160 });

    const summary = incidents.length
      ? incidents
          .slice(0, 3)
          .map((i) => {
            const top = i.result.classes?.[0];
            return `${i.status === "drop" ? "A drop" : "An early warning"} starting ${i.onset_date ?? "recently"}${i.result.drop ? ` (${Math.round(i.result.drop.effect * 100)}% below the prior level)` : ""}. ${top ? `Most likely cause: ${CAUSE_LABELS[top.cause].title.toLowerCase()}, ${i.result.confidence} confidence.` : ""}`;
          })
          .join(" ")
      : "No reach drops were detected this period.";

    const html = `<!doctype html><html><head><meta charset="utf-8"><title>${h(ws?.name ?? "")} · Pinterest report</title><style>${CSS}</style></head><body>
<h1 style="color:${brand.color}">Pinterest account report · @${h(conn.username)}</h1>
<div class="muted">${h(ws?.name ?? "")} · ${start} to ${end}${env().PINTEREST_MODE === "mock" ? " · <b>SIMULATED DATA (mock Pinterest API)</b>" : ""}</div>
<h2>Summary</h2><p>${h(summary)}</p>
<div><span class="k">Impressions<b>${sum(cur.impressions).toLocaleString("en-US")}</b><span class="muted">${pct(sum(cur.impressions), sum(prev.impressions))} vs prior 30 days</span></span>
<span class="k">Outbound clicks<b>${sum(cur.clicks).toLocaleString("en-US")}</b><span class="muted">${pct(sum(cur.clicks), sum(prev.clicks))}</span></span>
<span class="k">Saves<b>${sum(cur.saves).toLocaleString("en-US")}</b><span class="muted">${pct(sum(cur.saves), sum(prev.saves))}</span></span>
<span class="k">Health score<b>${health.at(-1)?.score ?? "–"}</b><span class="muted">${health.length > 1 ? `${health[0]!.score} at period start` : ""}</span></span></div>
<h2>Daily impressions</h2>${chart}<h2>Clicks and saves</h2>${chart2}
<h2>What happened</h2>${incidents.length ? `<table><tr><th>Onset</th><th>Type</th><th>Likely cause</th><th>Evidence</th><th>Status</th></tr>${incidents
      .map((i) => {
        const top = i.result.classes?.[0];
        return `<tr><td>${h(i.onset_date ?? "")}</td><td>${i.status === "drop" ? "Drop" : "Warning"}</td><td>${top ? `${h(CAUSE_LABELS[top.cause].title)}<br><span class="muted">${Math.round(top.probability * 100)}% · ${h(i.result.confidence)}</span>` : "–"}</td><td>${(i.result.evidence ?? []).slice(0, 3).map((e) => h(e.text)).join("<br>")}</td><td>${h(i.state)}</td></tr>`;
      })
      .join("")}</table>` : "<p>No incidents.</p>"}
<h2>Open checks</h2>${issues.length ? `<table><tr><th>Issue</th><th>Whose to fix</th><th>Severity</th><th>State</th></tr>${issues
      .map((i) => `<tr><td>${h(i.title)}</td><td><span class="chip">${i.source === "you" ? "You" : i.source === "pinterest" ? "Pinterest" : "Unknown"}</span></td><td>${h(i.severity)}</td><td>${h(i.state)}</td></tr>`)
      .join("")}</table>` : "<p>No open issues.</p>"}
<h2>What's next</h2><p>Keep publishing normally while any platform-side drop resolves; fix the items marked "You" first; we re-check them automatically and mark them passed when the fix holds.</p>
<div class="foot">${h(brand.footer)} Causes are likely explanations from this account's own data, not confirmations from Pinterest.</div></body></html>`;

    const [r] = await tx<{ id: string }[]>`
      INSERT INTO report (workspace_id, connection_id, kind, period_start, period_end, html, created_by, white_label)
      VALUES (${workspaceId}, ${connectionId}, 'monthly', ${start}, ${end}, ${html}, ${actor}, ${tx.json({ name: brand.name, color: brand.color } as never)}) RETURNING id`;
    await audit(tx, { orgId, workspaceId, actor, action: "report.created", target: r!.id, detail: { kind: "monthly" } });
    return r!.id;
  }, orgId);
}

/** Evidence pack for Pinterest's "creator stats drop" support ticket. Facts only; no promises. */
export async function buildEvidencePack(workspaceId: string, orgId: string, incidentId: string, actor: string) {
  return withWorkspace(workspaceId, async (tx) => {
    const inc = await one(tx<{ connection_id: string; onset_date: string | null; warning_date: string | null; result: DiagnoseResponse; detected_at: Date }[]>`
      SELECT connection_id, to_char(onset_date,'YYYY-MM-DD') AS onset_date, to_char(warning_date,'YYYY-MM-DD') AS warning_date, result, detected_at FROM incident WHERE id = ${incidentId}`);
    const conn = await one(tx<{ username: string; claimed_sites: { website?: string; status?: string }[] }[]>`SELECT username, claimed_sites FROM pinterest_connection WHERE id = ${inc.connection_id}`);
    const onset = inc.onset_date ?? inc.warning_date ?? todayUtc();
    const s = await series(tx, inc.connection_id, addDays(onset, -21), addDays(onset, 20) > todayUtc() ? todayUtc() : addDays(onset, 20));
    const checks = await tx<{ url: string; http_status: number | null; total_ms: number | null; hops: unknown[]; robots: { blocked?: boolean; crawlDelay?: number | null } | null; error: string | null; checked_at: Date }[]>`
      SELECT url, http_status, total_ms, hops, robots, error, checked_at FROM check_result WHERE connection_id = ${inc.connection_id}
      AND run_id = (SELECT run_id FROM check_result WHERE connection_id = ${inc.connection_id} ORDER BY checked_at DESC LIMIT 1)`;
    const observed = await tx<{ kind: string; note: string | null; observed_on: string }[]>`
      SELECT kind, note, to_char(observed_on,'YYYY-MM-DD') AS observed_on FROM observed_signal WHERE connection_id = ${inc.connection_id} ORDER BY observed_on DESC LIMIT 20`;
    const brand = await brandFor(orgId, tx);
    const r = inc.result;
    const before = s.impressions.slice(0, 21);
    const after = s.impressions.slice(21);
    const avg = (a: number[]) => (a.length ? Math.round(sum(a) / a.length) : 0);
    const ticket = [
      `Account: @${conn.username}`,
      `Issue: account-wide impressions dropped starting ${onset}.`,
      `Average daily impressions: ${avg(before).toLocaleString("en-US")} in the 21 days before, ${avg(after).toLocaleString("en-US")} since (${r.drop ? Math.round(r.drop.effect * 100) : "?"}% lower).`,
      r.rate.verdict === "stable" ? `Outbound click-through rate is unchanged (${fmtPct(r.rate.ctr_before)} before vs ${fmtPct(r.rate.ctr_after)} after), which suggests Pins are being shown less rather than performing worse when shown.` : "",
      ...r.evidence.slice(0, 4).map((e) => `- ${e.text}`),
      checks.length ? `Our own landing-page checks on ${checks[0]!.checked_at.toISOString().slice(0, 10)}: ${checks.filter((c) => c.http_status && c.http_status < 400).length}/${checks.length} sampled Pin links load correctly; ${checks.filter((c) => c.robots?.blocked).length} blocked by robots.txt.` : "",
      `Claimed websites: ${(conn.claimed_sites ?? []).map((w) => `${w.website} (${w.status ?? "status unknown"})`).join(", ") || "none"}.`,
      "Request: could you confirm whether the account, any linked domain, or recent Pins are subject to limited distribution, and if so which policy applies?",
    ].filter(Boolean).join("\n");

    const html = `<!doctype html><html><head><meta charset="utf-8"><title>Evidence pack · @${h(conn.username)}</title><style>${CSS}</style></head><body>
<h1 style="color:${brand.color}">Evidence pack · @${h(conn.username)}</h1><div class="muted">Drop onset ${h(onset)} · generated ${new Date().toISOString().slice(0, 10)}${env().PINTEREST_MODE === "mock" ? " · <b>SIMULATED DATA (mock Pinterest API)</b>" : ""}</div>
<h2>Timeline</h2>${lineChartSvg({ dates: s.dates, series: [{ name: "Impressions", values: s.impressions, color: brand.color }, { name: "Outbound clicks ×20", values: s.clicks.map((c) => c * 20), color: "#9ca3af" }], markers: [{ date: onset, label: "onset" }] })}
<h2>Findings</h2><table><tr><th>Finding</th><th>Supports</th></tr>${r.evidence.map((e) => `<tr><td>${h(e.text)}</td><td>${e.supports.map((c) => h(CAUSE_LABELS[c as keyof typeof CAUSE_LABELS]?.title ?? c)).join(", ")}</td></tr>`).join("")}</table>
<h2>Breadth of the drop</h2><table><tr><th>Segment</th><th>After / before</th></tr>
${Object.entries(r.breadth.age ?? {}).map(([k, v]) => `<tr><td>Pins aged ${h(k)} days</td><td>${fmtRatio(v)}</td></tr>`).join("")}
${(r.breadth.domains ?? []).map((d) => `<tr><td>Pins linking to ${h(d.domain)}</td><td>${fmtRatio(d.ratio)}</td></tr>`).join("")}
${r.breadth.unlinked_ratio !== null ? `<tr><td>Pins without a link</td><td>${fmtRatio(r.breadth.unlinked_ratio)}</td></tr>` : ""}</table>
<h2>Landing-page checks</h2>${checks.length ? `<table><tr><th>URL</th><th>Status</th><th>Load</th><th>Redirects</th><th>robots.txt</th></tr>${checks.map((c) => `<tr><td>${h(c.url)}</td><td>${c.http_status ?? h(c.error ?? "")}</td><td>${c.total_ms ?? "–"} ms</td><td>${c.hops.length}</td><td>${c.robots?.blocked ? "blocks Pinterestbot" : "ok"}${c.robots?.crawlDelay ? ` (crawl-delay ${c.robots.crawlDelay})` : ""}</td></tr>`).join("")}</table>` : "<p>No checks run yet.</p>"}
<h2>What you observed in Pinterest</h2>${observed.length ? `<ul>${observed.map((o) => `<li>${h(o.observed_on)}: ${h(o.kind.replace(/_/g, " "))}${o.note ? ` — ${h(o.note)}` : ""}</li>`).join("")}</ul>` : "<p>None recorded. Add screenshots you take in Pinterest to your ticket.</p>"}
<h2>Suggested ticket text</h2><p class="muted">Submit once, under Pinterest's creator-stats-drop category. Pinterest limits how many appeals and reports one person can file, so avoid duplicates.</p><pre>${h(ticket)}</pre>
<div class="foot">${h(brand.footer)} This pack states facts from your account's data and PinPulse's checks; it does not assert what Pinterest did.</div></body></html>`;
    const [rep] = await tx<{ id: string }[]>`
      INSERT INTO report (workspace_id, connection_id, kind, incident_id, period_start, period_end, html, created_by)
      VALUES (${workspaceId}, ${inc.connection_id}, 'evidence_pack', ${incidentId}, ${s.dates[0]!}, ${s.dates.at(-1)!}, ${html}, ${actor}) RETURNING id`;
    await audit(tx, { orgId, workspaceId, actor, action: "report.created", target: rep!.id, detail: { kind: "evidence_pack", incident: incidentId } });
    return { id: rep!.id, ticket };
  }, orgId);
}

function fmtPct(v: number | null) {
  return v === null ? "–" : `${(v * 100).toFixed(2)}%`;
}
function fmtRatio(v: number) {
  return `${Math.round(v * 100)}%`;
}

export async function createShareLink(workspaceId: string, reportId: string, actor: string, days = 30) {
  const token = newToken();
  await withWorkspace(workspaceId, async (tx) => {
    await tx`UPDATE report SET share_token_hash = ${hashToken(token)}, share_expires_at = now() + make_interval(days => ${days}) WHERE id = ${reportId}`;
    await audit(tx, { workspaceId, actor, action: "report.shared", target: reportId, detail: { days } });
  });
  return `${env().APP_URL}/r/${token}`;
}

export async function revokeShareLink(workspaceId: string, reportId: string, actor: string) {
  await withWorkspace(workspaceId, async (tx) => {
    await tx`UPDATE report SET share_token_hash = NULL, share_expires_at = NULL WHERE id = ${reportId}`;
    await audit(tx, { workspaceId, actor, action: "report.unshared", target: reportId });
  });
}
