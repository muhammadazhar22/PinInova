import { env } from "@/env";
import { num, withWorkspace, type Tx } from "@/lib/db";
import { lockConnection } from "@/modules/pinterest/guard";
import { addDays, dateRange, daysBetween, todayUtc } from "@/lib/dates";
import { analytics, CAUSE_LABELS, type DiagnoseRequest, type DiagnoseResponse } from "./analytics-client";
import { computeHealth } from "./score";
import { loadPinCohorts, NEW_PINS_ISSUE, newPinsFinding, newPinsIssueText } from "./new-pins";

interface AccRow { date: string; impressions: bigint | null; outbound_clicks: bigint | null; saves: bigint | null; pin_clicks: bigint | null }

/** Build the per-tenant request for the analytics service. Never includes another tenant's data. */
export async function buildRequest(tx: Tx, connectionId: string, now = new Date()): Promise<{ req: DiagnoseRequest; dates: string[] } | null> {
  const end = addDays(todayUtc(now), 0);
  const rows = await tx<AccRow[]>`
    SELECT DISTINCT ON (date) to_char(date, 'YYYY-MM-DD') AS date, impressions, outbound_clicks, saves, pin_clicks
    FROM account_metrics_daily WHERE connection_id = ${connectionId} AND split_key = 'all' AND date <= ${end}
      AND date >= ${addDays(end, -559)}
    ORDER BY date, CASE source WHEN 'api' THEN 0 ELSE 1 END`;
  if (rows.length < 14) return null;
  const first = rows[0]!.date;
  const last = rows[rows.length - 1]!.date;
  const dates = dateRange(first, last);
  const byDate = new Map(rows.map((r) => [r.date, r]));
  const series = (k: keyof Omit<AccRow, "date">) => interpolate(dates.map((d) => (byDate.has(d) && byDate.get(d)![k] !== null ? num(byDate.get(d)![k]) : null)));

  // Pin-level breakdowns only exist for the API window.
  const pinRows = await tx<{ date: string; pin_id: string; impressions: bigint | null; created: string | null; domain: string | null; has_link: boolean | null }[]>`
    SELECT to_char(m.date, 'YYYY-MM-DD') AS date, m.pin_id, m.impressions, to_char(p.pin_created_at, 'YYYY-MM-DD') AS created, p.link_domain AS domain, p.has_link
    FROM pin_metrics_daily m LEFT JOIN pin_meta p ON p.connection_id = m.connection_id AND p.pin_id = m.pin_id
    WHERE m.connection_id = ${connectionId} AND m.date >= ${first}`;
  const idx = new Map(dates.map((d, i) => [d, i]));
  const zero = () => new Array<number>(dates.length).fill(0);
  let age: Record<"0-7" | "8-14" | "15-29" | "30+", number[]> | null = null;
  let unlinked: number[] | null = null;
  const domains = new Map<string, number[]>();
  if (pinRows.length > 0) {
    age = { "0-7": zero(), "8-14": zero(), "15-29": zero(), "30+": zero() };
    unlinked = zero();
    for (const r of pinRows) {
      const i = idx.get(r.date);
      if (i === undefined) continue;
      const v = num(r.impressions);
      if (r.created) {
        const a = daysBetween(r.created, r.date);
        const b = a <= 7 ? "0-7" : a <= 14 ? "8-14" : a <= 29 ? "15-29" : "30+";
        age[b]![i]! += v;
      }
      if (r.has_link && r.domain) {
        if (!domains.has(r.domain)) domains.set(r.domain, zero());
        domains.get(r.domain)![i]! += v;
      } else if (r.has_link === false) unlinked[i]! += v;
    }
    // Pin coverage starts later than account history when CSV history exists: null out pre-coverage.
    const firstPin = pinRows.reduce((m, r) => (r.date < m ? r.date : m), last);
    const cut = idx.get(firstPin) ?? 0;
    if (cut > 0) {
      // The service expects equal lengths; leading zeros before coverage would look like growth, so drop breakdowns
      // when coverage is less than 28 days, else keep (the service compares windows around the onset only).
      if (dates.length - cut < 28) age = null;
    }
  }

  const signals = await buildSignals(tx, connectionId, end);
  const req: DiagnoseRequest = {
    dates,
    impressions: series("impressions"),
    outbound_clicks: series("outbound_clicks"),
    saves: series("saves"),
    pin_clicks: series("pin_clicks"),
    provisional_days: env().PROVISIONAL_DAYS,
    age_buckets: age,
    domains: domains.size ? [...domains.entries()].map(([domain, impressions]) => ({ domain, impressions })) : null,
    unlinked_impressions: unlinked,
    signals,
    min_drop: 0.5,
  };
  return { req, dates };
}

async function buildSignals(tx: Tx, connectionId: string, end: string): Promise<DiagnoseRequest["signals"]> {
  const observed = await tx<{ kind: string }[]>`
    SELECT DISTINCT kind FROM observed_signal WHERE connection_id = ${connectionId} AND observed_on >= ${addDays(end, -30)}`;
  const kinds = new Set(observed.map((o) => o.kind));
  // Bulk pattern: any day in the last 14 with more than 25 new Pins.
  const [bulk] = await tx<{ n: number }[]>`
    SELECT coalesce(max(c), 0)::int AS n FROM (SELECT count(*) AS c FROM pin_meta WHERE connection_id = ${connectionId}
      AND pin_created_at >= ${addDays(end, -14)} GROUP BY pin_created_at::date) s`;
  // Duplicate-URL rate: share of Pins created in the last 14 days whose link was used by another Pin within the 7 days before.
  const [dup] = await tx<{ total: number; dup: number }[]>`
    SELECT count(*)::int AS total,
           count(*) FILTER (WHERE EXISTS (SELECT 1 FROM pin_meta q WHERE q.connection_id = p.connection_id AND q.link = p.link AND q.pin_id <> p.pin_id
             AND q.pin_created_at BETWEEN p.pin_created_at - interval '7 days' AND p.pin_created_at))::int AS dup
    FROM pin_meta p WHERE p.connection_id = ${connectionId} AND p.has_link AND p.pin_created_at >= ${addDays(end, -14)}`;
  const [leak] = await tx<{ leak_ratio: number | null }[]>`
    SELECT leak_ratio FROM traffic_leak_result WHERE connection_id = ${connectionId} ORDER BY created_at DESC LIMIT 1`;
  // Year-over-year: same 28-day window last year vs the 28 days before it, from CSV history if imported.
  const [yoy] = await tx<{ a: number | null; b: number | null }[]>`
    SELECT (SELECT avg(impressions) FROM account_metrics_daily WHERE connection_id = ${connectionId} AND split_key = 'all'
              AND date BETWEEN ${addDays(end, -365 - 28)} AND ${addDays(end, -365)}) AS a,
           (SELECT avg(impressions) FROM account_metrics_daily WHERE connection_id = ${connectionId} AND split_key = 'all'
              AND date BETWEEN ${addDays(end, -365 - 56)} AND ${addDays(end, -365 - 29)}) AS b`;
  const yoyRatio = yoy?.a && yoy?.b && Number(yoy.b) > 0 ? Number(yoy.a) / Number(yoy.b) : null;
  return {
    domain_block_error: kinds.has("domain_block_error"),
    visit_site_demoted: kinds.has("visit_site_demoted") ? true : null,
    bulk_upload_or_ad_prefix: (bulk?.n ?? 0) > 25,
    duplicate_url_rate_14d: dup && dup.total > 0 ? dup.dup / dup.total : 0,
    peers_hit_fraction: null, // policy: PA-06 — never computed from other tenants' API data
    yoy_same_window_ratio: yoyRatio,
    ga4_pinterest_vs_direct_gap: leak?.leak_ratio ?? null,
  };
}

/** Linear interpolation over internal gaps; leading/trailing gaps take the nearest value. */
export function interpolate(xs: (number | null)[]): number[] {
  const out = [...xs] as (number | null)[];
  const known = out.map((v, i) => (v === null ? -1 : i)).filter((i) => i >= 0);
  if (known.length === 0) return out.map(() => 0);
  for (let i = 0; i < out.length; i++) {
    if (out[i] !== null) continue;
    const prev = [...known].reverse().find((k) => k < i);
    const next = known.find((k) => k > i);
    if (prev === undefined) out[i] = out[next!]!;
    else if (next === undefined) out[i] = out[prev]!;
    else out[i] = out[prev]! + ((out[next]! - out[prev]!) * (i - prev)) / (next - prev);
  }
  return out.map((v) => Math.max(0, Math.round(v!)));
}

/** Per-Pin before/after totals around an onset for decomposition. */
async function pinWindows(tx: Tx, connectionId: string, onset: string) {
  const rows = await tx<{ pin_id: string; before: bigint; after: bigint }[]>`
    SELECT pin_id,
      coalesce(sum(impressions) FILTER (WHERE date BETWEEN ${addDays(onset, -14)} AND ${addDays(onset, -1)}), 0) AS before,
      coalesce(sum(impressions) FILTER (WHERE date BETWEEN ${onset} AND ${addDays(onset, 13)}), 0) AS after
    FROM pin_metrics_daily WHERE connection_id = ${connectionId} AND date BETWEEN ${addDays(onset, -14)} AND ${addDays(onset, 13)}
    GROUP BY pin_id`;
  return rows.map((r) => ({ pin_id: r.pin_id, before: num(r.before), after: num(r.after) }));
}

export interface AnalyzeResult {
  result: DiagnoseResponse | null;
  incidentId: string | null;
  score: number | null;
}

export async function analyzeAccount(workspaceId: string, connectionId: string, opts: { now?: Date; fetchImpl?: typeof fetch } = {}): Promise<AnalyzeResult> {
  const now = opts.now ?? new Date();
  const built = await withWorkspace(workspaceId, (tx) => buildRequest(tx, connectionId, now));
  if (!built) return { result: null, incidentId: null, score: null };
  let res = await analytics.diagnose(built.req, opts.fetchImpl);
  if (res.status === "drop" && res.onset_date) {
    const pins = await withWorkspace(workspaceId, (tx) => pinWindows(tx, connectionId, res.onset_date!));
    if (pins.length) res = await analytics.diagnose({ ...built.req, pins }, opts.fetchImpl);
  }
  const domainDrops = res.status === "drop" ? [] : await scanDomains(built.req, opts.fetchImpl);

  return withWorkspace(workspaceId, async (tx) => {
    await lockConnection(tx, connectionId);
    let incidentId: string | null = null;
    if (res.status !== "none") {
      const top = res.classes[0]?.cause ?? null;
      const key = res.onset_date ?? res.warning_date;
      const [row] = await tx<{ id: string }[]>`
        INSERT INTO incident (workspace_id, connection_id, status, tier, onset_date, warning_date, effect, p_value, methods_agree, confidence, shape, top_cause, result, detector_version)
        VALUES (${workspaceId}, ${connectionId}, ${res.status}, ${res.status === "drop" ? "drop_detected" : "watch"}, ${key}, ${res.warning_date},
                ${res.drop?.effect ?? null}, ${res.p_value}, ${res.methods_agree}, ${res.confidence}, ${res.shape}, ${top}, ${tx.json(res as never)}, ${res.detector_version})
        ON CONFLICT (connection_id, onset_date) WHERE onset_date IS NOT NULL DO UPDATE SET
          status = EXCLUDED.status, effect = EXCLUDED.effect, p_value = EXCLUDED.p_value, methods_agree = EXCLUDED.methods_agree,
          confidence = EXCLUDED.confidence, shape = EXCLUDED.shape, top_cause = EXCLUDED.top_cause, result = EXCLUDED.result,
          detector_version = EXCLUDED.detector_version,
          tier = CASE WHEN incident.tier = 'watch' AND EXCLUDED.status = 'drop' THEN 'drop_detected' ELSE incident.tier END
        RETURNING id`;
      incidentId = row!.id;
      if (res.status === "drop" && top) {
        const label = CAUSE_LABELS[top];
        await upsertIssue(tx, workspaceId, connectionId, `cause:${top}`, label.source, "error", label.title, { incident_id: incidentId, evidence: res.evidence.slice(0, 5) });
      }
    }
    if (domainDrops.length) {
      const worst = domainDrops[0]!;
      await upsertIssue(tx, workspaceId, connectionId, "domain:traffic_drop", "unknown", "warning",
        `Pins linking to ${domainDrops.length === 1 ? worst.domain : `${domainDrops.length} domains`} lost ${Math.round(worst.effect * 100)}% of impressions since ${worst.onset}`,
        { domains: domainDrops, basis: "tracked Pins only; the account as a whole did not cross the drop threshold" }, domainDrops.length);
    } else if (res.status !== "drop") {
      await closeIssuesNotIn(tx, connectionId, "domain:traffic_drop", []);
    }
    // New Pins not distributed while older Pins carry the account (SPEC-079): below the account-level drop threshold.
    const cohorts = await loadPinCohorts(tx, connectionId, todayUtc(now), env().PROVISIONAL_DAYS);
    const newPins = newPinsFinding(cohorts.newMeans, cohorts.olderMeans);
    if (newPins) {
      const t = newPinsIssueText(newPins);
      await upsertIssue(tx, workspaceId, connectionId, NEW_PINS_ISSUE, "unknown", "warning", t.title, t.detail, newPins.newCount);
    } else {
      await closeIssuesNotIn(tx, connectionId, NEW_PINS_ISSUE, []);
    }
    const score = await computeHealth(tx, workspaceId, connectionId, res, todayUtc(now));
    return { result: res, incidentId, score };
  });
}

/**
 * A drop confined to one linked domain can stay under the account-level threshold (cause A signature:
 * Pinterest applies domain-level enforcement). Run the same detector on each sizeable domain series.
 */
async function scanDomains(req: DiagnoseRequest, fetchImpl?: typeof fetch) {
  const out: { domain: string; onset: string; effect: number }[] = [];
  const doms = (req.domains ?? [])
    .map((d) => ({ d, mean: d.impressions.slice(0, 60).reduce((a, b) => a + (b ?? 0), 0) / Math.max(1, Math.min(60, d.impressions.length)) }))
    .filter((x) => x.mean >= 30)
    .sort((a, b) => b.mean - a.mean)
    .slice(0, 5);
  for (const { d } of doms) {
    const r = await analytics.diagnose({
      dates: req.dates, impressions: d.impressions, outbound_clicks: d.impressions.map(() => 0),
      provisional_days: req.provisional_days, min_drop: req.min_drop,
    }, fetchImpl).catch(() => null);
    if (r?.status === "drop" && r.drop && r.onset_date) out.push({ domain: d.domain, onset: r.onset_date, effect: r.drop.effect });
  }
  return out.sort((a, b) => b.effect - a.effect);
}

export async function upsertIssue(tx: Tx, workspaceId: string, connectionId: string, kind: string, source: "pinterest" | "you" | "unknown", severity: "error" | "warning" | "info", title: string, detail: Record<string, unknown>, count = 1) {
  await tx`
    INSERT INTO issue (workspace_id, connection_id, kind, source, severity, title, detail, affected_count)
    VALUES (${workspaceId}, ${connectionId}, ${kind}, ${source}, ${severity}, ${title}, ${tx.json(detail as never)}, ${count})
    ON CONFLICT (connection_id, kind) DO UPDATE SET last_seen = now(), detail = EXCLUDED.detail, affected_count = EXCLUDED.affected_count,
      severity = EXCLUDED.severity, title = EXCLUDED.title,
      state = CASE WHEN issue.state IN ('passed', 'resolved') THEN 'regressed' WHEN issue.state = 'suppressed' THEN 'suppressed' ELSE issue.state END`;
}

/** Mark issues no longer observed: validating issues pass; open issues resolve. */
export async function closeIssuesNotIn(tx: Tx, connectionId: string, prefix: string, stillOpen: string[]) {
  await tx`
    UPDATE issue SET state = CASE WHEN state = 'validating' THEN 'passed' ELSE 'resolved' END
    WHERE connection_id = ${connectionId} AND kind LIKE ${prefix + "%"} AND state IN ('open', 'validating', 'regressed')
      AND NOT (kind = ANY(${stillOpen}))`;
}
