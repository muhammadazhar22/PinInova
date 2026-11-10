import { inflateSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { crc32 } from "../src/png.ts";
import { get, login, startEnv, type Env } from "./helpers.ts";

let env: Env;
let token: string;
beforeAll(async () => {
  env = await startEnv({}, { slowDelayMs: 400 });
  token = (await login(env.api, "mock_new_pins_zero")).access_token;
});
afterAll(() => env.close());

function decodePng(buf: Buffer): { width: number; height: number; bitDepth: number; colorType: number; rows: Buffer[] } {
  expect(buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(true);
  let off = 8;
  let ihdr: Buffer | null = null;
  const idat: Buffer[] = [];
  let sawEnd = false;
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.subarray(off + 4, off + 8).toString("ascii");
    const data = buf.subarray(off + 8, off + 8 + len);
    expect(buf.readUInt32BE(off + 8 + len)).toBe(crc32(buf.subarray(off + 4, off + 8 + len)));
    if (type === "IHDR") ihdr = data;
    if (type === "IDAT") idat.push(data);
    if (type === "IEND") sawEnd = true;
    off += 12 + len;
  }
  expect(sawEnd).toBe(true);
  const width = ihdr!.readUInt32BE(0);
  const height = ihdr!.readUInt32BE(4);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 3 + 1;
  expect(raw.length).toBe(stride * height);
  const rows = Array.from({ length: height }, (_, y) => raw.subarray(y * stride + 1, (y + 1) * stride));
  return { width, height, bitDepth: ihdr![8], colorType: ihdr![9], rows };
}

describe("Pin images", () => {
  it("serves decodable 64x64 RGB PNGs; duplicates are byte-identical; variants differ in exactly one row", async () => {
    const pins = (await get(env.api, token, "/v5/pins", { page_size: 250 })).body.items as { link: string | null; media: { images: Record<string, { url: string }> } }[];
    const byLink = new Map<string, string[]>();
    for (const p of pins) if (p.link) byLink.set(p.link, [...(byLink.get(p.link) ?? []), p.media.images["600x"].url]);
    const dupUrls = [...byLink.values()].sort((a, b) => b.length - a.length)[0];
    expect(dupUrls.length).toBeGreaterThanOrEqual(15);
    const bufs = await Promise.all(
      dupUrls.map(async (u) => {
        const r = await fetch(u);
        expect(r.status).toBe(200);
        expect(r.headers.get("content-type")).toBe("image/png");
        return Buffer.from(await r.arrayBuffer());
      }),
    );
    const groups = new Map<string, Buffer>();
    for (const b of bufs) groups.set(b.toString("base64"), b);
    const sorted = [...groups.keys()].sort((a, b) => bufs.filter((x) => x.toString("base64") === b).length - bufs.filter((x) => x.toString("base64") === a).length);
    const original = decodePng(groups.get(sorted[0])!);
    expect(original).toMatchObject({ width: 64, height: 64, bitDepth: 8, colorType: 2 });
    expect(sorted.length).toBeGreaterThan(1);
    for (const k of sorted.slice(1)) {
      const v = decodePng(groups.get(k)!);
      const changed = v.rows.map((row, y) => (row.equals(original.rows[y]) ? -1 : y)).filter((y) => y >= 0);
      expect(changed).toHaveLength(1);
    }
    // distinct (non-duplicate) Pins get distinct images
    const others = pins.filter((p) => !dupUrls.includes(p.media.images["600x"].url)).slice(0, 5);
    const ob = await Promise.all(others.map((p) => fetch(p.media.images["600x"].url).then(async (r) => Buffer.from(await r.arrayBuffer()).toString("base64"))));
    expect(new Set(ob).size).toBe(5);
    expect((await fetch(`${env.api.url}/__img/123.png`)).status).toBe(404);
  });
});

describe("mock websites", () => {
  const site = (p: string, init?: RequestInit) => fetch(`${env.sites.url}${p}`, { redirect: "manual", ...init });

  it("normal pages return 200 with <title> matching the Pin title", async () => {
    const t = (await login(env.api, "mock_healthy")).access_token;
    const pins = (await get(env.api, t, "/v5/pins", { page_size: 30 })).body.items.filter((p: { link: string | null }) => p.link);
    for (const p of pins.slice(0, 10)) {
      const r = await fetch(p.link, { headers: { "user-agent": "Mozilla/5.0 (compatible; Pinterestbot/1.0; +https://www.pinterest.com/bot.html)" } });
      expect(r.status).toBe(200);
      const html = await r.text();
      expect(html).toContain(`<title>${p.title}</title>`);
    }
  });

  it("redirect-shop answers with a 3-hop redirect chain to the final page", async () => {
    const chain: number[] = [];
    let url = `${env.sites.url}/redirect-shop/handmade-ceramic-vase-shop-p70001`;
    for (let i = 0; i < 6; i++) {
      const r = await fetch(url, { redirect: "manual" });
      chain.push(r.status);
      if (r.status >= 300 && r.status < 400) url = new URL(r.headers.get("location")!, url).toString();
      else {
        expect(await r.text()).toContain("<title>Handmade Ceramic Vase Shop</title>");
        break;
      }
    }
    expect(chain).toEqual([301, 302, 307, 200]);
  });

  it("broken-links 404s for /old/ paths; slow-blog delays /slow/ paths", async () => {
    expect((await site("/broken-links/old/leather-tote-outfit-p50001")).status).toBe(404);
    expect((await site("/broken-links/leather-tote-outfit-p50002")).status).toBe(200);
    const t0 = Date.now();
    expect((await site("/slow-blog/slow/hidden-lake-tips-p80001")).status).toBe(200);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(380);
    const t1 = Date.now();
    await site("/slow-blog/hidden-lake-tips-p80002");
    expect(Date.now() - t1).toBeLessThan(300);
  });

  it("robots.txt: deal-hub disallows Pinterestbot; crawl-delay-co sets Crawl-delay: 10", async () => {
    const deal = await (await site("/deal-hub/robots.txt")).text();
    expect(deal).toMatch(/User-agent: Pinterestbot\nDisallow: \//);
    const cd = await (await site("/crawl-delay-co/robots.txt")).text();
    expect(cd).toContain("Crawl-delay: 10");
    const normal = await (await site("/cozy-kitchen/robots.txt")).text();
    expect(normal).not.toContain("Disallow: /\n");
  });

  it("mock_domain_block's collapsing domain is the robots-blocked one", async () => {
    const t = (await login(env.api, "mock_domain_block")).access_token;
    const sites = (await get(env.api, t, "/v5/user_account/websites")).body.items.map((i: { website: string }) => i.website);
    expect(sites).toContain(`${env.sites.url}/deal-hub`);
  });

  it("logs requests with user agents; reset clears the log", async () => {
    await fetch(`${env.sites.url}/__requests/reset`, { method: "POST" });
    await site("/garden-notes/small-garden-ideas-p1", { headers: { "user-agent": "Pinterest/0.2 (+https://www.pinterest.com/bot.html)" } });
    await site("/deal-hub/robots.txt", { headers: { "user-agent": "PinInovaIntegrity/1.0" } });
    const log = ((await (await fetch(`${env.sites.url}/__requests`)).json()) as { requests: unknown[] }).requests;
    expect(log).toHaveLength(2);
    expect(log[0]).toMatchObject({ method: "GET", path: "/garden-notes/small-garden-ideas-p1", slug: "garden-notes", user_agent: "Pinterest/0.2 (+https://www.pinterest.com/bot.html)", status: 200 });
    expect(log[1]).toMatchObject({ slug: "deal-hub", user_agent: "PinInovaIntegrity/1.0" });
    await fetch(`${env.sites.url}/__requests/reset`, { method: "POST" });
    expect(((await (await fetch(`${env.sites.url}/__requests`)).json()) as { requests: unknown[] }).requests).toHaveLength(0);
  });
});
