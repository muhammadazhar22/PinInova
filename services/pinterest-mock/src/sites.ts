/**
 * MOCK websites server: stands in for the merchant/blog sites that mock Pins link to.
 * Every "domain" is a path prefix: <base>/<slug>/... (robots.txt at <base>/<slug>/robots.txt).
 * Behaviours per slug are listed in catalog.ts and README.md.
 */
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { SITES, SITE_BY_SLUG } from "./catalog.ts";
import { connectableBase, resolveSitePort, type MockSitesOptions } from "./config.ts";
import { titleFromPathSegment } from "./data.ts";
import type { RunningMock } from "./server.ts";

export interface SiteRequestLog {
  at: string;
  method: string;
  path: string;
  slug: string | null;
  user_agent: string | null;
  status: number;
}

const MOCK_HEADER = "x-mock-site";
const MAX_LOG = 5000;

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function page(title: string, slug: string, path: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title>
<meta property="og:title" content="${esc(title)}">
<meta name="description" content="MOCK page on ${esc(slug)} (synthetic, PinInova pinterest-mock).">
</head><body>
<p style="background:#ffe08a;padding:6px;font-weight:700">MOCK website "${esc(slug)}" served by PinInova services/pinterest-mock. Not a real site.</p>
<h1>${esc(title)}</h1>
<p>Synthetic article for path <code>${esc(path)}</code>.</p>
</body></html>`;
}

export function robotsTxt(slug: string): string {
  const site = SITE_BY_SLUG.get(slug);
  if (site?.behaviour === "robots_disallow_pinterestbot") {
    return "# MOCK robots.txt\nUser-agent: Pinterestbot\nDisallow: /\n\nUser-agent: Pinterest\nDisallow: /\n\nUser-agent: *\nAllow: /\n";
  }
  if (site?.behaviour === "crawl_delay_10") {
    return "# MOCK robots.txt\nUser-agent: *\nCrawl-delay: 10\nAllow: /\n";
  }
  return "# MOCK robots.txt\nUser-agent: *\nAllow: /\n";
}

export async function createMockSites(options: MockSitesOptions = {}): Promise<RunningMock & { requests(): SiteRequestLog[] }> {
  const port = resolveSitePort(options.port);
  const host = options.host ?? process.env.MOCK_HOST ?? "127.0.0.1";
  const slowMs = options.slowDelayMs ?? (process.env.MOCK_SITE_SLOW_MS ? Number(process.env.MOCK_SITE_SLOW_MS) : 5000);
  const logEnabled = options.log ?? (process.env.MOCK_LOG === "true" || process.env.MOCK_LOG === "1");
  let log: SiteRequestLog[] = [];
  const timers = new Set<NodeJS.Timeout>();
  let base = "";

  const record = (method: string, path: string, slug: string | null, ua: string | null, status: number) => {
    log.push({ at: new Date().toISOString(), method, path, slug, user_agent: ua, status });
    if (log.length > MAX_LOG) log = log.slice(-MAX_LOG);
    if (logEnabled) process.stderr.write(`[MOCK sites] ${method} ${path} -> ${status} ua="${ua ?? ""}"\n`);
  };

  const send = (res: ServerResponse, status: number, body: string, type: string, extra: Record<string, string> = {}) => {
    res.writeHead(status, { "content-type": type, "content-length": Buffer.byteLength(body), [MOCK_HEADER]: "true", ...extra });
    res.end(body);
  };

  const server = createServer(async (req, res) => {
    const method = req.method ?? "GET";
    const url = new URL(req.url ?? "/", "http://sites.local");
    const path = url.pathname;
    const ua = (req.headers["user-agent"] as string | undefined) ?? null;

    // control endpoints (not logged)
    if (path === "/__requests" && method === "GET") {
      send(res, 200, JSON.stringify({ mock: true, requests: log }), "application/json; charset=utf-8");
      return;
    }
    if (path === "/__requests/reset" && method === "POST") {
      log = [];
      send(res, 200, JSON.stringify({ mock: true, ok: true }), "application/json; charset=utf-8");
      return;
    }

    const head = method === "HEAD";
    const reply = (status: number, body: string, type = "text/html; charset=utf-8", extra: Record<string, string> = {}) => {
      record(method, path + url.search, slug, ua, status);
      if (head) {
        res.writeHead(status, { "content-type": type, "content-length": Buffer.byteLength(body), [MOCK_HEADER]: "true", ...extra });
        res.end();
      } else send(res, status, body, type, extra);
    };

    const segs = path.split("/").filter(Boolean);
    const slug = segs[0] ?? null;

    if (method !== "GET" && method !== "HEAD") return reply(405, "Method not allowed", "text/plain; charset=utf-8");
    if (path === "/robots.txt") return reply(200, "# MOCK sites root\nUser-agent: *\nAllow: /\n", "text/plain; charset=utf-8");
    if (path === "/") {
      const list = SITES.map((s) => `<li><a href="/${s.slug}/">${s.slug}</a> — ${esc(s.behaviour)}: ${esc(s.description)}</li>`).join("");
      return reply(200, `<!doctype html><html><head><meta charset="utf-8"><title>MOCK websites (PinInova)</title></head><body><h1>MOCK websites — synthetic, not real sites</h1><ul>${list}</ul></body></html>`);
    }
    const site = slug ? SITE_BY_SLUG.get(slug) : undefined;
    if (!site) return reply(404, `<!doctype html><title>Not found</title><h1>404 — unknown MOCK site</h1>`);
    const rest = segs.slice(1);
    if (rest.length === 1 && rest[0] === "robots.txt") return reply(200, robotsTxt(site.slug), "text/plain; charset=utf-8");
    if (rest.length === 0) return reply(200, page(`${site.slug} (MOCK site home)`, site.slug, path));

    switch (site.behaviour) {
      case "redirect_chain_3": {
        // /slug/<p> -301-> /slug/r/1/<p> -302-> /slug/r/2/<p> -307-> /slug/final/<p> -> 200
        if (rest[0] === "final") return reply(200, page(titleFromPathSegment(rest[rest.length - 1]), site.slug, path));
        let next: string;
        let status: number;
        if (rest[0] === "r" && rest[1] === "1") {
          next = `/${site.slug}/r/2/${rest.slice(2).join("/")}`;
          status = 302;
        } else if (rest[0] === "r" && rest[1] === "2") {
          next = `/${site.slug}/final/${rest.slice(2).join("/")}`;
          status = 307;
        } else {
          next = `/${site.slug}/r/1/${rest.join("/")}`;
          status = 301;
        }
        const origin = req.headers.host ? `http://${req.headers.host}` : base;
        return reply(status, "", "text/plain; charset=utf-8", { location: `${origin}${next}${url.search}` });
      }
      case "not_found_old_paths":
        if (rest[0] === "old") return reply(404, `<!doctype html><html><head><title>Page not found</title></head><body><h1>404 — this product page was removed (MOCK)</h1></body></html>`);
        break;
      case "slow_path":
        if (rest[0] === "slow") {
          await new Promise<void>((resolve) => {
            const t = setTimeout(() => {
              timers.delete(t);
              resolve();
            }, slowMs);
            timers.add(t);
          });
          if (res.destroyed) return;
        }
        break;
      default:
        break;
    }
    return reply(200, page(titleFromPathSegment(rest[rest.length - 1]), site.slug, path));
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });
  const actualPort = (server.address() as AddressInfo).port;
  base = connectableBase(host, actualPort);
  return {
    url: base,
    port: actualPort,
    requests: () => [...log],
    close: () =>
      new Promise<void>((resolve, reject) => {
        for (const t of timers) clearTimeout(t);
        timers.clear();
        server.closeAllConnections?.();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
