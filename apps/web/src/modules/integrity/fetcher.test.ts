import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isBlockedAddress } from "@/lib/ssrf";
import { checkFetch, evaluateRobots } from "./fetcher";

let server: http.Server;
let base = "";
const seenUA: string[] = [];
beforeAll(async () => {
  server = http.createServer((req, res) => {
    seenUA.push(String(req.headers["user-agent"]));
    if (req.url === "/r1") return res.writeHead(301, { Location: "/r2" }).end();
    if (req.url === "/r2") return res.writeHead(302, { Location: "/ok" }).end();
    if (req.url === "/loop") return res.writeHead(302, { Location: "/loop" }).end();
    if (req.url === "/slow") return setTimeout(() => res.end("<title>slow</title>"), 1500);
    if (req.url === "/ok") return res.writeHead(200, { "content-type": "text/html" }).end("<html><title>Linen Bedding Guide</title></html>");
    res.writeHead(404).end("nope");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => server.close());

describe("checkFetch", () => {
  it("records every redirect hop and the final title", async () => {
    const r = await checkFetch(`${base}/r1`, { uaMode: "pinterestbot", allowPrivate: true });
    expect(r.status).toBe(200);
    expect(r.hops.map((h) => h.status)).toEqual([301, 302]);
    expect(r.title).toBe("Linen Bedding Guide");
    expect(seenUA.at(-1)).toContain("Pinterestbot");
  });
  it("stops redirect loops", async () => {
    const r = await checkFetch(`${base}/loop`, { uaMode: "honest", allowPrivate: true, maxHops: 3 });
    expect(r.error).toBe("too many redirects");
  });
  it("times out slow pages", async () => {
    const r = await checkFetch(`${base}/slow`, { uaMode: "honest", allowPrivate: true, timeoutMs: 300 });
    expect(r.error).toMatch(/timeout/);
  });
  it("blocks private and loopback targets unless explicitly allowed (SSRF)", async () => {
    const r = await checkFetch(`${base}/ok`, { uaMode: "honest", allowPrivate: false });
    expect(r.status).toBeNull();
    expect(r.error).toMatch(/blocked/);
    const meta = await checkFetch("http://169.254.169.254/latest/meta-data/", { uaMode: "honest", allowPrivate: false });
    expect(meta.error).toMatch(/blocked/);
    const viaDns = await checkFetch("http://localhost/x", { uaMode: "honest", allowPrivate: false });
    expect(viaDns.error).toMatch(/blocked/);
  });
  it("refuses non-http schemes", async () => {
    expect((await checkFetch("file:///etc/passwd", { uaMode: "honest", allowPrivate: true })).error).toBe("unsupported scheme");
  });
});

describe("robots", () => {
  it("applies the Pinterestbot group over *", () => {
    const t = "User-agent: *\nAllow: /\n\nUser-agent: Pinterestbot\nDisallow: /\n";
    expect(evaluateRobots(t, "/blog/x").blocked).toBe(true);
  });
  it("reads crawl-delay and longest-match rules", () => {
    const t = "User-agent: *\nCrawl-delay: 10\nDisallow: /private\nAllow: /private/ok\n";
    expect(evaluateRobots(t, "/private/ok/a")).toMatchObject({ blocked: false, crawlDelay: 10 });
    expect(evaluateRobots(t, "/private/x").blocked).toBe(true);
  });
  it("classifies addresses", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "192.168.0.1", "169.254.169.254", "::1", "fd00::1", "::ffff:10.0.0.1", "100.64.0.1"]) expect(isBlockedAddress(ip)).toBe(true);
    for (const ip of ["8.8.8.8", "151.101.1.1", "2606:4700::1111"]) expect(isBlockedAddress(ip)).toBe(false);
  });
  it("refuses every IPv6 encoding of internal addresses (review 2026-11-08 #2)", () => {
    for (const ip of ["[::1]", "::ffff:7f00:1", "::ffff:a9fe:a9fe", "::127.0.0.1", "::", "64:ff9b::a9fe:a9fe", "2002:7f00:1::",
      "fec0::1", "fe80::1%eth0", "2001::1", "not-an-ip", "0.0.0.0", "255.255.255.255", "198.18.0.1", "240.0.0.1"]) {
      expect(isBlockedAddress(ip), ip).toBe(true);
    }
  });
  it("refuses bracketed IPv6 literals in URLs before connecting", async () => {
    for (const u of ["http://[::1]/", "http://[::ffff:127.0.0.1]/", "http://[::ffff:169.254.169.254]/latest/", "http://[64:ff9b::a9fe:a9fe]/"]) {
      const r = await checkFetch(u, { uaMode: "honest", allowPrivate: false });
      expect(r.error, u).toBe("blocked address");
    }
  });
});
