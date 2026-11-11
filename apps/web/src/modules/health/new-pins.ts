import { addDays } from "@/lib/dates";
import type { Tx } from "@/lib/db";

/**
 * New Pins not distributed while the account total holds (SPEC-079; PLAN.md signature 1, cause C).
 *
 * The detector looks for causes only after the account total drops by `min_drop`; when older Pins carry the
 * account, a collapse of new Pins never crosses it. This compares cohorts of tracked Pins instead:
 * - "new": created 4–21 days ago; "older": created more than 35 days ago;
 * - per Pin, mean daily impressions on complete days from its 3rd day, within the last 16 days;
 * - flag when median(new) ≤ MAX_RATIO × median(older), with enough Pins in both and real traffic on older Pins.
 * Medians, because Pin performance is heavy-tailed (a few Pins carry most impressions).
 */
export const NEW_PINS_RULE = { minNew: 8, minOlder: 20, minOlderMedian: 5, maxRatio: 0.2 } as const;
export const NEW_PINS_ISSUE = "distribution:new_pins";

export interface NewPinsFinding {
  newCount: number;
  olderCount: number;
  newMedian: number;
  olderMedian: number;
  ratio: number;
}

export function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** Non-null = flag. Inputs are each Pin's mean daily impressions. */
export function newPinsFinding(newMeans: number[], olderMeans: number[]): NewPinsFinding | null {
  const r = NEW_PINS_RULE;
  if (newMeans.length < r.minNew || olderMeans.length < r.minOlder) return null;
  const newMedian = median(newMeans);
  const olderMedian = median(olderMeans);
  if (olderMedian < r.minOlderMedian) return null;
  const ratio = newMedian / olderMedian;
  if (ratio > r.maxRatio) return null;
  return { newCount: newMeans.length, olderCount: olderMeans.length, newMedian, olderMedian, ratio };
}

/** Each tracked Pin's mean daily impressions, by cohort. `provisionalDays` recent days are incomplete and excluded. */
export async function loadPinCohorts(tx: Tx, connectionId: string, today: string, provisionalDays: number) {
  const rows = await tx<{ cohort: "new" | "older"; mean: number }[]>`
    WITH p AS (
      SELECT pin_id, pin_created_at::date AS cd,
        CASE WHEN pin_created_at >= ${addDays(today, -21)}::date AND pin_created_at < ${addDays(today, -4)}::date THEN 'new'
             WHEN pin_created_at < ${addDays(today, -35)}::date THEN 'older' END AS cohort
      FROM pin_meta WHERE connection_id = ${connectionId} AND pin_created_at IS NOT NULL)
    SELECT p.cohort, avg(d.impressions)::float8 AS mean
    FROM p JOIN pin_metrics_daily d ON d.connection_id = ${connectionId} AND d.pin_id = p.pin_id
      AND d.date >= greatest(p.cd + 2, ${addDays(today, -16)}::date) AND d.date < ${addDays(today, -provisionalDays)}::date
    WHERE p.cohort IS NOT NULL
    GROUP BY p.cohort, p.pin_id`;
  return {
    newMeans: rows.filter((r) => r.cohort === "new").map((r) => Number(r.mean)),
    olderMeans: rows.filter((r) => r.cohort === "older").map((r) => Number(r.mean)),
  };
}

const views = (x: number) => (x < 10 ? x.toFixed(1).replace(/\.0$/, "") : String(Math.round(x)));

export function newPinsIssueText(f: NewPinsFinding) {
  return {
    title: `${f.newCount} new Pins from the last 3 weeks get about ${views(f.newMedian)} views a day; older Pins get about ${views(f.olderMedian)}`,
    detail: {
      new_pins: f.newCount,
      older_pins: f.olderCount,
      new_median_daily_impressions: Math.round(f.newMedian * 10) / 10,
      older_median_daily_impressions: Math.round(f.olderMedian * 10) / 10,
      ratio: Math.round(f.ratio * 1000) / 1000,
      basis:
        "Tracked Pins only. New = created 4–21 days ago, older = created over 35 days ago; median of each Pin's mean daily " +
        "impressions on complete days from its 3rd day. The account as a whole did not cross the drop threshold.",
      likely_cause:
        "Most often a publishing pattern that Pinterest's spam systems down-rank: the same image reused, one link on many " +
        "Pins, or many Pins published at once. See Content integrity and Cadence for this account.",
    },
  };
}
