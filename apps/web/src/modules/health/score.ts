import { num, type Tx } from "@/lib/db";
import { addDays, domainKey } from "@/lib/dates";
import type { DiagnoseResponse } from "./analytics-client";

/**
 * Health score = mean of the available sub-grades (each 0–100). Published formula, shown in the UI:
 * - Distribution: 100 with no drop; 65 during an unconfirmed warning; 100 × (1 − effect), floored at 10 and capped at 60, during a confirmed drop.
 * - Link quality: share of checked Pin links that return 2xx within 4 s with at most one redirect and no robots block.
 * - Domain trust: 100 if every linked domain is a claimed website and none blocks Pinterestbot; −25 per unclaimed domain, −40 per blocking robots.txt.
 * - Content integrity: 100 − 100 × (share of recent Pins in duplicate-image clusters) − 40 × (duplicate-link rate).
 * - Cadence: 100 − 15 per week in the last 8 whose new-Pin count exceeds 3× the median week.
 * Bands: Weak 0–30, Fair 31–70, Good 71–90, Excellent 91–100.
 */
export function band(score: number) {
  return score <= 30 ? "weak" : score <= 70 ? "fair" : score <= 90 ? "good" : "excellent";
}

export async function computeHealth(tx: Tx, workspaceId: string, connectionId: string, res: DiagnoseResponse | null, today: string): Promise<number | null> {
  const sub: Record<string, number | null> = {};

  sub.distribution = !res || res.status === "none" ? 100 : res.status === "warning" ? 65 : Math.max(10, Math.min(60, Math.round(100 * (1 - (res.drop?.effect ?? 0.5)))));

  const checks = await tx<{ ok: boolean }[]>`
    SELECT (http_status BETWEEN 200 AND 299 AND coalesce(total_ms, 99999) < 4000 AND jsonb_array_length(hops) <= 1
            AND coalesce((robots->>'blocked')::boolean, false) = false) AS ok
    FROM check_result WHERE connection_id = ${connectionId}
      AND run_id = (SELECT run_id FROM check_result WHERE connection_id = ${connectionId} ORDER BY checked_at DESC LIMIT 1)`;
  sub.link_quality = checks.length ? Math.round((100 * checks.filter((c) => c.ok).length) / checks.length) : null;

  const [conn] = await tx<{ claimed_sites: { website?: string; status?: string }[] }[]>`SELECT claimed_sites FROM pinterest_connection WHERE id = ${connectionId}`;
  const domains = await tx<{ d: string }[]>`SELECT DISTINCT link_domain AS d FROM pin_meta WHERE connection_id = ${connectionId} AND link_domain IS NOT NULL`;
  if (domains.length) {
    const claimed = new Set(
      (conn?.claimed_sites ?? []).filter((s) => !s.status || /verif|success|claimed/i.test(s.status)).map((s) => domainKey(s.website ?? "") ?? ""),
    );
    const robotsBlocked = await tx<{ domain: string }[]>`
      SELECT DISTINCT domain FROM check_result WHERE connection_id = ${connectionId} AND (robots->>'blocked')::boolean
        AND checked_at > now() - interval '14 days'`;
    const unclaimed = domains.filter((d) => !claimed.has(d.d)).length;
    sub.domain_trust = Math.max(0, 100 - 25 * unclaimed - 40 * robotsBlocked.length);
  } else sub.domain_trust = null;

  const [ci] = await tx<{ total: number; in_cluster: number }[]>`
    SELECT count(*)::int AS total, count(*) FILTER (WHERE duplicate_cluster IS NOT NULL)::int AS in_cluster
    FROM pin_meta WHERE connection_id = ${connectionId} AND pin_created_at >= ${addDays(today, -30)}`;
  sub.content_integrity = ci && ci.total > 0 ? Math.max(0, Math.round(100 - (100 * ci.in_cluster) / ci.total)) : null;

  const weeks = await tx<{ n: bigint }[]>`
    SELECT count(*) AS n FROM pin_meta WHERE connection_id = ${connectionId} AND pin_created_at >= ${addDays(today, -56)}
    GROUP BY date_trunc('week', pin_created_at)`;
  if (weeks.length >= 3) {
    const counts = weeks.map((w) => num(w.n)).sort((a, b) => a - b);
    const median = counts[Math.floor(counts.length / 2)]!;
    const spikes = counts.filter((c) => median > 0 && c > 3 * median).length;
    sub.cadence = Math.max(0, 100 - 15 * spikes);
  } else sub.cadence = null;

  const vals = Object.values(sub).filter((v): v is number => v !== null);
  if (!vals.length) return null;
  const score = Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);
  await tx`
    INSERT INTO health_snapshot (workspace_id, connection_id, date, score, band, subgrades)
    VALUES (${workspaceId}, ${connectionId}, ${today}, ${score}, ${band(score)}, ${tx.json(sub as never)})
    ON CONFLICT (connection_id, date) DO UPDATE SET score = EXCLUDED.score, band = EXCLUDED.band, subgrades = EXCLUDED.subgrades`;
  return score;
}
