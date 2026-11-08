import { domainKey } from "@/lib/dates";
import { isClaimed } from "@/modules/health/score";
import type { AnalyticsResponse, UserWebsite } from "./types";

/**
 * Checks for the Pinterest v5 contract details the mock had to guess (docs/INTEGRATIONS.md), run against real responses
 * by scripts/smoke-live.ts (SPEC-076). Pure functions over response *shapes*: results carry key names, counts and
 * formats, never metric values, Pin IDs or URLs beyond the account's own claimed domains.
 */
export type CheckStatus = "pass" | "warn" | "fail" | "skip";
export interface CheckResult { id: string; status: CheckStatus; detail: string }

const METRICS = ["IMPRESSION", "OUTBOUND_CLICK", "PIN_CLICK", "SAVE"] as const;
const KNOWN_SITE_STATUS = /^(verified|unverified|pending|success|claimed|failed|failure)$/i;

export function checkAnalyticsSplits(noSplit: AnalyticsResponse, owned: AnalyticsResponse): CheckResult {
  const id = "analytics_split_keys";
  const keys = Object.keys(noSplit ?? {});
  const ownedKeys = Object.keys(owned ?? {});
  if (keys.length !== 1) return { id, status: "fail", detail: `NO_SPLIT returned ${keys.length} keys (${keys.join(", ") || "none"}); sync stores NO_SPLIT rows under one key and needs exactly one` };
  const days = noSplit[keys[0]!]?.daily_metrics ?? [];
  const badDate = days.find((d) => !/^\d{4}-\d{2}-\d{2}$/.test(d.date));
  if (badDate) return { id, status: "fail", detail: `daily_metrics.date is not YYYY-MM-DD (e.g. "${badDate.date}")` };
  const seen = new Set(days.flatMap((d) => Object.keys(d.metrics ?? {})));
  const missing = days.length ? METRICS.filter((m) => !seen.has(m)) : [];
  if (missing.length) return { id, status: "fail", detail: `metric names missing from daily_metrics: ${missing.join(", ")} (seen: ${[...seen].join(", ") || "none"})` };
  return { id, status: "pass", detail: `NO_SPLIT key "${keys[0]}" (${days.length} days); OWNED_CONTENT keys: ${ownedKeys.join(", ") || "none"} (stored lower-cased as owned:<key>)` };
}

export function checkTimestamps(values: (string | undefined | null)[]): CheckResult {
  const id = "timestamps";
  const v = values.filter((x): x is string => !!x);
  if (!v.length) return { id, status: "skip", detail: "no Pins with created_at" };
  const bad = v.filter((s) => Number.isNaN(Date.parse(s)));
  if (bad.length) return { id, status: "fail", detail: `${bad.length}/${v.length} created_at values do not parse (e.g. "${bad[0]}")` };
  const zoned = v.filter((s) => /([zZ]|[+-]\d{2}:?\d{2})$/.test(s)).length;
  if (zoned < v.length) return { id, status: "warn", detail: `${v.length - zoned}/${v.length} created_at values have no offset; stored as UTC (utcStamp) — confirm Pinterest means UTC` };
  return { id, status: "pass", detail: `${v.length} created_at values, all RFC 3339 with offset (e.g. "${v[0]}")` };
}

export function checkWebsites(sites: UserWebsite[]): CheckResult {
  const id = "user_account_websites";
  if (!sites.length) return { id, status: "skip", detail: "account has no websites listed" };
  const noDomain = sites.filter((s) => !domainKey(s.website ?? "", "live"));
  if (noDomain.length) return { id, status: "fail", detail: `${noDomain.length}/${sites.length} websites give no domain (e.g. "${noDomain[0]?.website}")` };
  const withScheme = sites.filter((s) => (s.website ?? "").includes("://")).length;
  const statuses = [...new Set(sites.map((s) => s.status ?? "(none)"))];
  const unknown = statuses.filter((s) => s !== "(none)" && !KNOWN_SITE_STATUS.test(s));
  const claimed = sites.filter(isClaimed).length;
  const detail = `${sites.length} sites, ${withScheme} with scheme; statuses: ${statuses.join(", ")}; counted as claimed: ${claimed}`;
  return unknown.length ? { id, status: "warn", detail: `${detail}. Unknown status values ${unknown.join(", ")}: check isClaimed() (health/score.ts)` } : { id, status: "pass", detail };
}

/** PA-08: how many of the most recent days Pinterest still marks as not final. */
export function checkProvisional(noSplit: AnalyticsResponse): CheckResult {
  const id = "pa08_provisional_days";
  const days = Object.values(noSplit ?? {})[0]?.daily_metrics ?? [];
  if (!days.length) return { id, status: "skip", detail: "no daily metrics" };
  const sorted = [...days].sort((a, b) => b.date.localeCompare(a.date));
  let n = 0;
  for (const d of sorted) {
    if (d.data_status && !/^READY$/i.test(d.data_status)) n++;
    else break;
  }
  const statuses = [...new Set(days.map((d) => d.data_status ?? "(none)"))];
  return { id, status: "pass", detail: `${n} day(s) at the end not READY (PROVISIONAL_DAYS assumes 2); data_status values: ${statuses.join(", ")}` };
}

export function summarize(results: CheckResult[]) {
  return { ok: !results.some((r) => r.status === "fail"), counts: Object.fromEntries((["pass", "warn", "fail", "skip"] as const).map((s) => [s, results.filter((r) => r.status === s).length])) };
}
