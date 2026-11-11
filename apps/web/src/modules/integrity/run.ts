import { isClaimed } from "@/modules/health/score";
import { lockConnection } from "@/modules/pinterest/guard";
import { randomUUID } from "node:crypto";
import { env } from "@/env";
import { withWorkspace } from "@/lib/db";
import { domainKey } from "@/lib/dates";
import { analytics } from "@/modules/health/analytics-client";
import { closeIssuesNotIn, upsertIssue } from "@/modules/health/analyze";
import type { PinterestClient } from "@/modules/pinterest/client";
import { clientFor, markNeedsReauth } from "@/modules/pinterest/connections";
import { PinterestAuthError } from "@/modules/pinterest/errors";
import type { Pin } from "@/modules/pinterest/types";
import { checkFetch, evaluateRobots, type FetchResult } from "./fetcher";

const SAMPLE_PER_DOMAIN = 5;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function tokens(s: string) {
  return new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3));
}
/** Content match: share of meaningful words in the Pin title that appear in the landing page title. */
export function titleMatch(pinTitle: string | null | undefined, pageTitle: string | null): boolean | null {
  if (!pinTitle || !pageTitle) return null;
  const a = tokens(pinTitle);
  if (!a.size) return null;
  const b = tokens(pageTitle);
  return [...a].filter((w) => b.has(w)).length / a.size >= 0.5;
}

export function robotsUrlFor(link: string, mode: "mock" | "live"): { url: string; path: string } {
  const u = new URL(link);
  if (mode === "mock" && (u.hostname === "127.0.0.1" || u.hostname === "localhost")) {
    const [slug, ...rest] = u.pathname.split("/").filter(Boolean);
    return { url: `${u.origin}/${slug}/robots.txt`, path: "/" + rest.join("/") };
  }
  return { url: `${u.origin}/robots.txt`, path: u.pathname };
}

/**
 * Link and domain integrity for ONE tenant's own Pin links (policy: PA-07). The allowlist is
 * implicit: only URLs taken from this account's own Pins are ever fetched.
 */
/** Issue kinds under this module's prefixes that analysis owns; link checks never close them. */
const ANALYSIS_OWNED_KINDS = ["domain:traffic_drop"];

export async function runIntegrityChecks(workspaceId: string, connectionId: string, opts: { client?: PinterestClient; pins?: Pin[] } = {}) {
  const e = env();
  const pins: Pin[] = opts.pins ?? [];
  try {
    const client = opts.client ?? (await clientFor(workspaceId, connectionId));
    if (!opts.pins) for await (const p of client.listPins({ pageSize: 250 })) pins.push(p);
  } catch (err) {
    // Same as sync: a rejected token flags the connection so the UI asks the user to reconnect (CLAUDE.md: 401 → re-auth).
    if (err instanceof PinterestAuthError) await markNeedsReauth(workspaceId, connectionId, err.message);
    throw err;
  }
  const fetchOpts = { uaMode: e.INTEGRITY_UA_MODE, allowPrivate: e.INTEGRITY_ALLOW_PRIVATE_HOSTS && e.PINTEREST_MODE === "mock", timeoutMs: 8000 } as const;

  // Sample: newest Pins per domain (titles are used in memory only and never stored — policy: PA-02).
  const byDomain = new Map<string, Pin[]>();
  for (const p of [...pins].sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""))) {
    const d = domainKey(p.link, e.PINTEREST_MODE);
    if (!d || !p.link) continue;
    const list = byDomain.get(d) ?? [];
    if (list.length < SAMPLE_PER_DOMAIN && !list.some((x) => x.link === p.link)) list.push(p);
    byDomain.set(d, list);
  }

  const runId = randomUUID();
  const results: Array<{ pin: Pin; domain: string; r: FetchResult; robots: ReturnType<typeof evaluateRobots> & { url: string; found: boolean } }> = [];
  for (const [domain, list] of byDomain) {
    const first = list[0]!;
    const ru = robotsUrlFor(first.link!, e.PINTEREST_MODE);
    const rr = await checkFetch(ru.url, { ...fetchOpts, readBody: true });
    const robotsText = rr.status === 200 ? rr.body ?? "" : "";
    for (const pin of list) {
      const path = robotsUrlFor(pin.link!, e.PINTEREST_MODE).path;
      const verdict = { url: ru.url, found: rr.status === 200, ...evaluateRobots(robotsText, path) };
      const r = await checkFetch(pin.link!, fetchOpts);
      results.push({ pin, domain, r, robots: verdict });
      await sleep(e.NODE_ENV === "test" ? 0 : 1000); // at most 1 request/second per domain
    }
  }

  const [conn] = await withWorkspace(workspaceId, (tx) => tx<{ claimed_sites: { website?: string; status?: string }[] }[]>`SELECT claimed_sites FROM pinterest_connection WHERE id = ${connectionId}`);
  const claimed = new Set((conn?.claimed_sites ?? []).filter(isClaimed).map((s) => domainKey(s.website ?? "", e.PINTEREST_MODE)));

  // Duplicate images among recent Pins (policy: PA-03 — hashes computed transiently by the analytics service).
  let dup: { clusters: string[][]; duplicate_rate: number } | null = null;
  const recent = pins.filter((p) => p.media?.images).sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? "")).slice(0, 120);
  if (recent.length >= 2) {
    const items: { pin_id: string; image_base64: string }[] = [];
    for (const p of recent) {
      const img = p.media?.images?.["150x150"]?.url ?? Object.values(p.media?.images ?? {})[0]?.url;
      if (!img) continue;
      const bytes = await fetchPinImage(img, e.PINTEREST_MODE, e.PINTEREST_API_BASE);
      if (!bytes) continue;
      items.push({ pin_id: p.id, image_base64: bytes.toString("base64") });
    }
    if (items.length >= 2) dup = await analytics.duplicates(items).catch(() => null);
  }

  await withWorkspace(workspaceId, async (tx) => {
    await lockConnection(tx, connectionId);
    for (const x of results) {
      await tx`
        INSERT INTO check_result (workspace_id, connection_id, run_id, url, domain, final_url, hops, http_status, total_ms, robots, title_match, claimed, error, ua_mode)
        VALUES (${workspaceId}, ${connectionId}, ${runId}, ${x.pin.link!}, ${x.domain}, ${x.r.finalUrl}, ${tx.json(x.r.hops as never)}, ${x.r.status}, ${x.r.totalMs},
                ${tx.json(x.robots as never)}, ${titleMatch(x.pin.title, x.r.title)}, ${claimed.has(x.domain)}, ${x.r.error}, ${e.INTEGRITY_UA_MODE})`;
    }
    const open: string[] = [];
    const issue = async (kind: string, severity: "error" | "warning" | "info", title: string, detail: Record<string, unknown>, count: number) => {
      open.push(kind);
      await upsertIssue(tx, workspaceId, connectionId, kind, "you", severity, title, detail, count);
    };
    const byKind = <T,>(f: (x: (typeof results)[number]) => T | false) => results.filter((x) => f(x) !== false);
    const broken = byKind((x) => x.r.status !== null && x.r.status >= 400);
    if (broken.length) await issue("link:broken", "error", `${broken.length} Pin links return an error page`, { urls: broken.map((b) => ({ url: b.pin.link, status: b.r.status })) }, broken.length);
    const unreachable = byKind((x) => x.r.status === null);
    if (unreachable.length) await issue("link:unreachable", "error", `${unreachable.length} Pin links could not be loaded`, { urls: unreachable.map((b) => ({ url: b.pin.link, error: b.r.error })) }, unreachable.length);
    const slow = byKind((x) => x.r.status !== null && x.r.totalMs >= 4000);
    if (slow.length) await issue("link:slow", "warning", `${slow.length} landing pages take 4 s or longer (Pinterest's guidance: under 4 s)`, { urls: slow.map((b) => ({ url: b.pin.link, ms: b.r.totalMs })) }, slow.length);
    const chains = byKind((x) => x.r.hops.length > 1);
    if (chains.length) await issue("link:redirect_chain", "warning", `${chains.length} Pin links pass through redirect chains`, { urls: chains.map((b) => ({ url: b.pin.link, hops: b.r.hops.length })) }, chains.length);
    const mismatch = byKind((x) => titleMatch(x.pin.title, x.r.title) === false);
    if (mismatch.length) await issue("link:content_mismatch", "warning", `${mismatch.length} landing pages don't match their Pin's title`, { urls: mismatch.map((b) => b.pin.link) }, mismatch.length);
    const robotsBlocked = [...new Map(results.filter((x) => x.robots.blocked).map((x) => [x.domain, x])).values()];
    if (robotsBlocked.length) await issue("domain:robots_blocks_pinterestbot", "error", `robots.txt blocks Pinterestbot on ${robotsBlocked.length} domain(s)`, { domains: robotsBlocked.map((x) => ({ domain: x.domain, robots: x.robots.url })) }, robotsBlocked.length);
    const delay = [...new Map(results.filter((x) => (x.robots.crawlDelay ?? 0) > 1).map((x) => [x.domain, x])).values()];
    if (delay.length) await issue("domain:crawl_delay", "warning", `Crawl-delay above 1 second on ${delay.length} domain(s); Pinterest treats larger values as 1 and says large delays hurt distribution`, { domains: delay.map((x) => ({ domain: x.domain, delay: x.robots.crawlDelay })) }, delay.length);
    const unclaimed = [...byDomain.keys()].filter((d) => !claimed.has(d));
    if (unclaimed.length) await issue("domain:unclaimed", "info", `${unclaimed.length} linked domain(s) are not claimed in Pinterest`, { domains: unclaimed }, unclaimed.length);
    if (dup && dup.clusters.length) {
      const inClusters = dup.clusters.flat();
      for (const [i, c] of dup.clusters.entries()) await tx`UPDATE pin_meta SET duplicate_cluster = ${i + 1} WHERE connection_id = ${connectionId} AND pin_id = ANY(${c})`;
      await tx`UPDATE pin_meta SET duplicate_cluster = NULL WHERE connection_id = ${connectionId} AND NOT (pin_id = ANY(${inClusters}))`;
      await issue("content:duplicate_images", "warning", `${inClusters.length} recent Pins reuse the same image (${dup.clusters.length} groups)`, { clusters: dup.clusters, duplicate_rate: dup.duplicate_rate }, inClusters.length);
    }
    await closeIssuesNotIn(tx, connectionId, "link:", open);
    // domain:traffic_drop is raised and closed by analysis (analyze.ts), not here: closing it would flip an open
    // warning to resolved → regressed every night and mark a user's "I fixed this" as passed without a check.
    await closeIssuesNotIn(tx, connectionId, "domain:", [...open, ...ANALYSIS_OWNED_KINDS]);
    if (dup) await closeIssuesNotIn(tx, connectionId, "content:", open);
  });
  return { runId, checked: results.length, domains: byDomain.size, duplicates: dup?.clusters.length ?? 0 };
}

/**
 * Fetch a Pin image for transient hashing. Only Pinterest's image CDN (live) or the mock API host (mock)
 * is allowed, so this can never be pointed at an arbitrary URL.
 */
async function fetchPinImage(url: string, mode: "mock" | "live", apiBase: string): Promise<Buffer | null> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const allowed = mode === "live" ? u.protocol === "https:" && /(^|\.)pinimg\.com$/.test(u.hostname) : u.host === new URL(apiBase).host;
  if (!allowed) return null;
  const res = await fetch(u, { signal: AbortSignal.timeout(8000), redirect: "error" }).catch(() => null);
  if (!res?.ok) return null;
  const buf = Buffer.from(await res.arrayBuffer());
  return buf.length <= 2_000_000 ? buf : null;
}
