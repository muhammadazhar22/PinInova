import { readFile } from "node:fs/promises";
import { env } from "@/env";
import { redact } from "@/lib/crypto/vault";
import { domainKey, todayUtc } from "@/lib/dates";
import { analytics } from "@/modules/health/analytics-client";
import { isClaimed } from "@/modules/health/score";
import { checkFetch } from "@/modules/integrity/fetcher";
import { robotsUrlFor } from "@/modules/integrity/run";
import { clientFor } from "./connections";
import { type CheckResult, checkAnalyticsSplits, checkProvisional, checkTimestamps, checkWebsites, summarize } from "./contract-checks";
import type { Paginated, Pin } from "./types";

/**
 * Live smoke test (SPEC-076, docs/DEPLOYMENT.md Step 4.3): one connected account, read-only GET calls through the
 * rate-gated client, checking the five contract details the mock had to guess (docs/INTEGRATIONS.md). Nothing is
 * stored; the report holds shapes and counts only.
 */
export async function runSmoke(p: { workspaceId: string; connectionId: string; csvPath?: string; robotsLimit?: number }) {
  const e = env();
  const results: CheckResult[] = [];
  const guard = async (id: string, fn: () => Promise<CheckResult | CheckResult[]>) => {
    try {
      const r = await fn();
      results.push(...(Array.isArray(r) ? r : [r]));
    } catch (err) {
      results.push({ id, status: "fail", detail: redact((err as Error).message) });
    }
  };

  const client = await clientFor(p.workspaceId, p.connectionId);
  const end = todayUtc();
  const start = new Date(Date.parse(end) - 13 * 86400_000).toISOString().slice(0, 10);

  await guard("user_account", async () => {
    const a = await client.userAccount();
    return { id: "user_account", status: "pass", detail: `account_type ${a.account_type ?? "(none)"}` };
  });
  await guard("analytics_split_keys", async () => {
    const noSplit = await client.accountAnalytics({ start, end, split: "NO_SPLIT" });
    const owned = await client.accountAnalytics({ start, end, split: "OWNED_CONTENT" });
    return [checkAnalyticsSplits(noSplit, owned), checkProvisional(noSplit)];
  });
  await guard("timestamps", async () => {
    const page = await client.get<Paginated<Pin>>("/pins", { page_size: 25 });
    return checkTimestamps((page.items ?? []).map((x) => x.created_at));
  });

  let sites: Awaited<ReturnType<typeof client.websites>> = [];
  await guard("user_account_websites", async () => {
    sites = await client.websites();
    return checkWebsites(sites);
  });

  await guard("robots_txt", async () => {
    const claimed = sites.filter(isClaimed).filter((s) => domainKey(s.website ?? "", e.PINTEREST_MODE)).slice(0, p.robotsLimit ?? 3);
    if (!claimed.length) return { id: "robots_txt", status: "skip", detail: "no claimed website to check" };
    const out: string[] = [];
    let failed = 0;
    for (const s of claimed) {
      const site = (s.website ?? "").includes("://") ? s.website! : `https://${s.website}`;
      const { url } = robotsUrlFor(site.replace(/\/?$/, "/"), e.PINTEREST_MODE);
      // policy: PA-07 — the account's own claimed site, one request, SSRF-guarded fetcher.
      const r = await checkFetch(url, { uaMode: e.INTEGRITY_UA_MODE, allowPrivate: e.INTEGRITY_ALLOW_PRIVATE_HOSTS && e.PINTEREST_MODE === "mock", timeoutMs: 8000 });
      if (r.status === null) failed++;
      out.push(`${domainKey(site, e.PINTEREST_MODE)} → ${r.status ?? r.error}`);
    }
    return { id: "robots_txt", status: failed ? "warn" : "pass", detail: `robots.txt at ${e.PINTEREST_MODE === "live" ? "/robots.txt" : "mock path"}: ${out.join("; ")}` };
  });

  await guard("analytics_csv_export", async () => {
    if (!p.csvPath) return { id: "analytics_csv_export", status: "skip", detail: "pass --csv <file> with a native Pinterest analytics export to check column aliases" };
    const r = await analytics.parseCsv(await readFile(p.csvPath, "utf8"), "pinterest_analytics");
    const matched = Object.keys(r.columns_matched);
    const ok = matched.includes("date") && matched.includes("impressions");
    return { id: "analytics_csv_export", status: ok ? (r.warnings.length ? "warn" : "pass") : "fail", detail: `matched: ${matched.join(", ") || "none"}; rows ${r.rows.length}${r.warnings.length ? `; warnings: ${r.warnings.join(" | ")}` : ""}` };
  });

  return { mode: e.PINTEREST_MODE, window: { start, end }, apiCalls: client.calls, results, ...summarize(results) };
}
