import http from "node:http";
import https from "node:https";
import { safeLookup, isBlockedAddress } from "@/lib/ssrf";
import net from "node:net";

export const UA = {
  // policy: PA-07 — Pinterest's published crawler strings; an honest secondary header identifies PinPulse.
  pinterestbot: "Mozilla/5.0 (compatible; Pinterestbot/1.0; +https://www.pinterest.com/bot.html)",
  honest: "PinPulseLinkCheck/1.0 (+https://pinpulse.app/link-check)",
} as const;

export interface Hop {
  url: string;
  status: number;
  ms: number;
}
export interface FetchResult {
  url: string;
  finalUrl: string | null;
  status: number | null;
  hops: Hop[];
  totalMs: number;
  title: string | null;
  error: string | null;
  body?: string;
}

export interface FetchOptions {
  uaMode: "pinterestbot" | "honest";
  allowPrivate: boolean;
  timeoutMs?: number;
  maxHops?: number;
  maxBytes?: number;
  readBody?: boolean;
}

function once(url: URL, o: FetchOptions): Promise<{ status: number; location: string | null; body: string; ms: number }> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    if (!o.allowPrivate) {
      if (net.isIP(url.hostname) && isBlockedAddress(url.hostname)) return reject(new Error("blocked address"));
      if (!["", "80", "443"].includes(url.port)) return reject(new Error("blocked port"));
    }
    const mod = url.protocol === "https:" ? https : http;
    const req = mod.request(
      url,
      {
        method: "GET",
        lookup: safeLookup(o.allowPrivate),
        headers: { "User-Agent": UA[o.uaMode], "X-PinPulse-Check": "1", Accept: "text/html,*/*;q=0.8" },
        timeout: o.timeoutMs ?? 8000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        const limit = o.maxBytes ?? 256 * 1024;
        res.on("data", (c: Buffer) => {
          size += c.length;
          if (size <= limit) chunks.push(c);
          else res.destroy();
        });
        const done = () => resolve({ status: res.statusCode ?? 0, location: res.headers.location ?? null, body: Buffer.concat(chunks).toString("utf8"), ms: Date.now() - started });
        res.on("end", done);
        res.on("close", done);
        res.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(new Error(`timeout after ${o.timeoutMs ?? 8000} ms`)));
    req.on("error", reject);
    req.end();
  });
}

/** GET with manual redirect handling so every hop is recorded and re-validated. */
export async function checkFetch(rawUrl: string, o: FetchOptions): Promise<FetchResult> {
  const hops: Hop[] = [];
  const started = Date.now();
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { url: rawUrl, finalUrl: null, status: null, hops, totalMs: 0, title: null, error: "invalid URL" };
  }
  for (let i = 0; i <= (o.maxHops ?? 10); i++) {
    if (!["http:", "https:"].includes(url.protocol)) return { url: rawUrl, finalUrl: url.toString(), status: null, hops, totalMs: Date.now() - started, title: null, error: "unsupported scheme" };
    try {
      const r = await once(url, o);
      if (r.status >= 300 && r.status < 400 && r.location) {
        hops.push({ url: url.toString(), status: r.status, ms: r.ms });
        url = new URL(r.location, url);
        continue;
      }
      const title = /<title[^>]*>([^<]*)<\/title>/i.exec(r.body)?.[1]?.trim() ?? null;
      return { url: rawUrl, finalUrl: url.toString(), status: r.status, hops, totalMs: Date.now() - started, title, error: null, body: o.readBody ? r.body : undefined };
    } catch (e) {
      return { url: rawUrl, finalUrl: url.toString(), status: null, hops, totalMs: Date.now() - started, title: null, error: (e as Error).message };
    }
  }
  return { url: rawUrl, finalUrl: url.toString(), status: null, hops, totalMs: Date.now() - started, title: null, error: "too many redirects" };
}

export interface RobotsVerdict {
  url: string;
  found: boolean;
  blocked: boolean;
  crawlDelay: number | null;
  matchedAgent: string | null;
}

/** Minimal robots.txt evaluation for Pinterestbot (falls back to the * group). */
export function evaluateRobots(text: string, path: string): Omit<RobotsVerdict, "url" | "found"> {
  const groups: { agents: string[]; rules: { allow: boolean; path: string }[]; delay: number | null }[] = [];
  let cur: (typeof groups)[number] | null = null;
  let lastWasAgent = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1]!.toLowerCase();
    const val = m[2]!.trim();
    if (key === "user-agent") {
      if (!cur || !lastWasAgent) groups.push((cur = { agents: [], rules: [], delay: null }));
      cur.agents.push(val.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!cur) continue;
    if (key === "disallow" && val) cur.rules.push({ allow: false, path: val });
    if (key === "allow" && val) cur.rules.push({ allow: true, path: val });
    if (key === "crawl-delay") cur.delay = Number(val) || null;
  }
  const g = groups.find((x) => x.agents.some((a) => a.includes("pinterestbot") || a === "pinterest")) ?? groups.find((x) => x.agents.includes("*"));
  if (!g) return { blocked: false, crawlDelay: null, matchedAgent: null };
  const matches = g.rules.filter((r) => path.startsWith(r.path.replace(/\*$/, ""))).sort((a, b) => b.path.length - a.path.length);
  return { blocked: matches[0] ? !matches[0].allow : false, crawlDelay: g.delay, matchedAgent: g.agents.join(",") };
}
