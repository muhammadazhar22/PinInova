import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { clearDatasetCache, getDataset } from "../src/data.ts";
import { parseIsoDate } from "../src/dates.ts";
import { TODAY, daysAgo, get, login, startEnv, type Env } from "./helpers.ts";

let env: Env;
const tokens = new Map<string, string>();
beforeAll(async () => {
  env = await startEnv();
  for (const u of ["mock_healthy", "mock_platform_cliff", "mock_domain_block", "mock_new_pins_zero", "mock_quality_drop", "mock_viral_fade", "mock_agency_client_1", "mock_agency_client_2"]) {
    tokens.set(u, (await login(env.api, u)).access_token);
  }
});
afterAll(() => env.close());

type Daily = { date: string; data_status: string; metrics: Record<string, number> }[];

async function accountDaily(user: string, start: string, end: string, extra: Record<string, string> = {}): Promise<Daily> {
  const r = await get(env.api, tokens.get(user)!, "/v5/user_account/analytics", { start_date: start, end_date: end, metric_types: "IMPRESSION,OUTBOUND_CLICK,SAVE", ...extra });
  expect(r.status).toBe(200);
  return r.body.all.daily_metrics;
}

async function allPins(user: string): Promise<{ id: string; link: string | null; created_at: string; media: { images: Record<string, { url: string }> } }[]> {
  const out = [];
  let bookmark: string | null = null;
  do {
    const r = await get(env.api, tokens.get(user)!, "/v5/pins", { page_size: 250, ...(bookmark ? { bookmark } : {}) });
    out.push(...r.body.items);
    bookmark = r.body.bookmark;
  } while (bookmark);
  return out;
}

async function pinDaily(user: string, pinIds: string[], start: string, end: string, metrics = "IMPRESSION,OUTBOUND_CLICK,SAVE", split = "NO_SPLIT"): Promise<Map<string, any>> {
  const res = new Map<string, any>();
  for (let i = 0; i < pinIds.length; i += 40) {
    const batch = pinIds.slice(i, i + 40);
    const rs = await Promise.all(batch.map((id) => get(env.api, tokens.get(user)!, `/v5/pins/${id}/analytics`, { start_date: start, end_date: end, metric_types: metrics, split_field: split })));
    rs.forEach((r, j) => {
      expect(r.status).toBe(200);
      res.set(batch[j], r.body);
    });
  }
  return res;
}

const sum = (d: Daily, m = "IMPRESSION", from = 0, to = d.length) => d.slice(from, to).reduce((s, x) => s + (x.metrics[m] ?? 0), 0);
const mean = (d: Daily, m: string, from: number, to: number) => sum(d, m, from, to) / (to - from);
/** index of a date in a 90-day series starting at daysAgo(89) */
const idx = (ago: number) => 89 - ago;
const domainOf = (link: string | null) => (link ? new URL(link).pathname.split("/")[1] : "(none)");

describe("generation", () => {
  it("is fast (< 1 s for all accounts) and deterministic by seed", () => {
    const today = parseIsoDate(TODAY)!;
    clearDatasetCache();
    const t0 = performance.now();
    const a = getDataset(4242, today);
    const ms = performance.now() - t0;
    expect(ms).toBeLessThan(1000);
    clearDatasetCache();
    const b = getDataset(4242, today);
    expect(a === b).toBe(false); // (never hand the multi-MB dataset itself to expect(): it gets pretty-printed)
    for (let i = 0; i < a.accounts.length; i++) {
      expect(Buffer.from(a.accounts[i].series.buffer).equals(Buffer.from(b.accounts[i].series.buffer))).toBe(true);
      expect(a.accounts[i].pins.map((p) => p.title)).toEqual(b.accounts[i].pins.map((p) => p.title));
    }
    const c = getDataset(4243, today);
    expect(Buffer.from(a.accounts[0].series.buffer).equals(Buffer.from(c.accounts[0].series.buffer))).toBe(false);
  });

  it("accounts have 150–400 Pins over 2 years, 4–8 boards, 2–3 domains, heavy-tailed performance", () => {
    const ds = getDataset(1, parseIsoDate(TODAY)!);
    for (const a of ds.accounts) {
      expect(a.pins.length).toBeGreaterThanOrEqual(150);
      expect(a.pins.length).toBeLessThanOrEqual(400);
      expect(a.boards.length).toBeGreaterThanOrEqual(4);
      expect(a.boards.length).toBeLessThanOrEqual(8);
      expect(a.def.domains.length).toBeGreaterThanOrEqual(2);
      expect(a.def.domains.length).toBeLessThanOrEqual(3);
      const span = ds.today - Math.min(...a.pins.map((p) => p.createdDay));
      expect(span).toBeGreaterThan(600);
      const last90 = a.pins.filter((p) => p.createdDay > ds.today - 90).length;
      expect((last90 / 90) * 7).toBeGreaterThanOrEqual(2.5);
      expect((last90 / 90) * 7).toBeLessThanOrEqual(10);
      expect(a.pins.some((p) => p.linkPath === null)).toBe(true);
      // top 10% of Pins carry most of the 90-day impressions
      const per = a.pins.map((p) => {
        let s = 0;
        for (let o = 730 - 90; o < 730; o++) s += a.series[p.idx * 4 * 730 + o];
        return s;
      });
      per.sort((x, y) => y - x);
      const total = per.reduce((x, y) => x + y, 0);
      const top = per.slice(0, Math.ceil(per.length / 10)).reduce((x, y) => x + y, 0);
      expect(top / total).toBeGreaterThan(0.45);
    }
  });
});

describe("per-Pin metrics add up to account totals (YOUR_PINS)", () => {
  it.each(["mock_domain_block", "mock_new_pins_zero"])("%s: daily and summary sums match, also per device", async (user) => {
    const start = daysAgo(29);
    const pins = await allPins(user);
    const per = await pinDaily(user, pins.map((p) => p.id), start, TODAY, "IMPRESSION,SAVE,PIN_CLICK,OUTBOUND_CLICK");
    const acct = await get(env.api, tokens.get(user)!, "/v5/user_account/analytics", { start_date: start, end_date: TODAY, source: "YOUR_PINS", metric_types: "IMPRESSION,SAVE,PIN_CLICK,OUTBOUND_CLICK" });
    const days: Daily = acct.body.all.daily_metrics;
    for (const m of ["IMPRESSION", "SAVE", "PIN_CLICK", "OUTBOUND_CLICK"]) {
      days.forEach((d, i) => {
        let s = 0;
        for (const body of per.values()) s += body.all.daily_metrics[i].metrics[m] ?? 0;
        expect(s, `${m} on ${d.date}`).toBe(d.metrics[m]);
      });
      let total = 0;
      for (const body of per.values()) total += body.all.summary_metrics[m];
      expect(total).toBe(acct.body.all.summary_metrics[m]);
    }
    // device split consistency for one metric
    const perApp = await pinDaily(user, pins.map((p) => p.id), start, TODAY, "IMPRESSION", "APP_TYPE");
    const acctApp = await get(env.api, tokens.get(user)!, "/v5/user_account/analytics", { start_date: start, end_date: TODAY, source: "YOUR_PINS", metric_types: "IMPRESSION", split_field: "APP_TYPE" });
    for (const app of ["MOBILE", "TABLET", "WEB"]) {
      let s = 0;
      for (const body of perApp.values()) s += body[app].summary_metrics.IMPRESSION;
      expect(s).toBe(acctApp.body[app].summary_metrics.IMPRESSION);
    }
  });
});

describe("scenario signatures", () => {
  const start = daysAgo(89);

  it("mock_healthy: weekly seasonality, mild trend, no cliff", async () => {
    const d = await accountDaily("mock_healthy", start, TODAY);
    const ratio = mean(d, "IMPRESSION", idx(14), idx(2)) / mean(d, "IMPRESSION", idx(60), idx(30));
    expect(ratio).toBeGreaterThan(0.9);
    expect(ratio).toBeLessThan(1.3);
    // no 7-day block falls more than 25% below the previous block
    const ready = d.slice(0, idx(2) + 1);
    for (let i = 14; i <= ready.length; i += 7) {
      expect(mean(ready, "IMPRESSION", i - 7, i) / mean(ready, "IMPRESSION", i - 14, i - 7)).toBeGreaterThan(0.75);
    }
    const byDow = new Map<number, number[]>();
    for (const x of ready) {
      const dow = new Date(`${x.date}T00:00:00Z`).getUTCDay();
      byDow.set(dow, [...(byDow.get(dow) ?? []), x.metrics.IMPRESSION]);
    }
    const avg = (dow: number) => byDow.get(dow)!.reduce((a, b) => a + b, 0) / byDow.get(dow)!.length;
    expect(avg(0) / avg(5)).toBeGreaterThan(1.1); // Sunday vs Friday
  });

  it("mock_platform_cliff (D): ~85% step drop from 25 days ago across Pin ages and domains, CTR unchanged", async () => {
    const d = await accountDaily("mock_platform_cliff", start, TODAY);
    const before = mean(d, "IMPRESSION", idx(60), idx(26) + 1);
    const after = mean(d, "IMPRESSION", idx(25), idx(2));
    expect(after / before).toBeGreaterThan(0.08);
    expect(after / before).toBeLessThan(0.22);
    expect(d[idx(25)].metrics.IMPRESSION / d[idx(26)].metrics.IMPRESSION).toBeLessThan(0.3); // a step, not a slide
    const ctr = (a: number, b: number) => sum(d, "OUTBOUND_CLICK", a, b) / sum(d, "IMPRESSION", a, b);
    const ctrRatio = ctr(idx(25), idx(2)) / ctr(idx(60), idx(26) + 1);
    expect(ctrRatio).toBeGreaterThan(0.8);
    expect(ctrRatio).toBeLessThan(1.2);
    // per domain and per Pin-age bucket
    const pins = (await allPins("mock_platform_cliff")).filter((p) => p.created_at.slice(0, 10) < daysAgo(70));
    const per = await pinDaily("mock_platform_cliff", pins.map((p) => p.id), start, TODAY, "IMPRESSION");
    const groups = new Map<string, { b: number; a: number }>();
    for (const p of pins) {
      const daily: Daily = per.get(p.id).all.daily_metrics;
      const age = p.created_at.slice(0, 10) < daysAgo(365) ? "old" : "mid";
      for (const key of [domainOf(p.link), age]) {
        const g = groups.get(key) ?? { b: 0, a: 0 };
        g.b += mean(daily, "IMPRESSION", idx(60), idx(26) + 1);
        g.a += mean(daily, "IMPRESSION", idx(25), idx(2));
        groups.set(key, g);
      }
    }
    for (const [key, g] of groups) expect(g.a / g.b, key).toBeLessThan(0.3);
  });

  it("mock_domain_block (A): deal-hub Pins fall ~95% from 30 days ago, others unchanged", async () => {
    const pins = await allPins("mock_domain_block");
    const per = await pinDaily("mock_domain_block", pins.map((p) => p.id), start, TODAY, "IMPRESSION");
    const groups = new Map<string, { b: number; a: number }>();
    for (const p of pins) {
      if (p.created_at.slice(0, 10) > daysAgo(60)) continue; // compare like-for-like Pins
      const daily: Daily = per.get(p.id).all.daily_metrics;
      const g = groups.get(domainOf(p.link)) ?? { b: 0, a: 0 };
      g.b += mean(daily, "IMPRESSION", idx(60), idx(31) + 1);
      g.a += mean(daily, "IMPRESSION", idx(30), idx(2));
      groups.set(domainOf(p.link), g);
    }
    expect([...groups.keys()].sort()).toEqual(["(none)", "cozy-kitchen", "deal-hub", "garden-notes"]);
    const r = (k: string) => groups.get(k)!.a / groups.get(k)!.b;
    expect(r("deal-hub")).toBeLessThan(0.1);
    expect(r("cozy-kitchen")).toBeGreaterThan(0.7);
    expect(r("garden-notes")).toBeGreaterThan(0.7);
    expect(r("(none)")).toBeGreaterThan(0.7);
  });

  it("mock_new_pins_zero (C): Pins from the last 21 days get 0–2 impressions/day; many are duplicates", async () => {
    const pins = await allPins("mock_new_pins_zero");
    const recent = pins.filter((p) => p.created_at.slice(0, 10) >= daysAgo(20));
    expect(recent.length).toBeGreaterThanOrEqual(25);
    const per = await pinDaily("mock_new_pins_zero", recent.map((p) => p.id), daysAgo(20), TODAY, "IMPRESSION");
    for (const p of recent) for (const x of per.get(p.id).all.daily_metrics as Daily) expect(x.metrics.IMPRESSION ?? 0).toBeLessThanOrEqual(2);
    const d = await accountDaily("mock_new_pins_zero", start, TODAY);
    expect(mean(d, "IMPRESSION", idx(14), idx(2)) / mean(d, "IMPRESSION", idx(60), idx(30))).toBeGreaterThan(0.8); // older Pins fine
    const byLink = new Map<string, typeof recent>();
    for (const p of recent) if (p.link) byLink.set(p.link, [...(byLink.get(p.link) ?? []), p]);
    const [dupLink, dups] = [...byLink.entries()].sort((a, b) => b[1].length - a[1].length)[0];
    expect(dups.length).toBeGreaterThanOrEqual(15);
    expect(dupLink).toContain("/garden-notes/");
    const imgs = await Promise.all(dups.map((p) => fetch(p.media.images["600x"].url).then(async (r) => Buffer.from(await r.arrayBuffer()))));
    const distinct = new Set(imgs.map((b) => b.toString("base64")));
    expect(distinct.size).toBeGreaterThanOrEqual(2); // a few one-row variants
    const counts = [...distinct].map((k) => imgs.filter((b) => b.toString("base64") === k).length).sort((a, b) => b - a);
    expect(counts[0]).toBeGreaterThanOrEqual(10); // most are byte-identical
  });

  it("mock_quality_drop (B): ~60% impression drop from 20 days ago and outbound CTR halves", async () => {
    const d = await accountDaily("mock_quality_drop", start, TODAY);
    const ratio = mean(d, "IMPRESSION", idx(20), idx(2)) / mean(d, "IMPRESSION", idx(60), idx(21) + 1);
    expect(ratio).toBeGreaterThan(0.3);
    expect(ratio).toBeLessThan(0.5);
    const ctr = (a: number, b: number) => sum(d, "OUTBOUND_CLICK", a, b) / sum(d, "IMPRESSION", a, b);
    const ctrRatio = ctr(idx(20), idx(2)) / ctr(idx(60), idx(21) + 1);
    expect(ctrRatio).toBeGreaterThan(0.35);
    expect(ctrRatio).toBeLessThan(0.65);
  });

  it("mock_viral_fade (E): one Pin peaked ~30 days ago with >50% of impressions, decaying smoothly", async () => {
    const top = await get(env.api, tokens.get("mock_viral_fade")!, "/v5/user_account/analytics/top_pins", { start_date: start, end_date: TODAY, sort_by: "IMPRESSION", num_of_pins: 3 });
    const acct = await accountDaily("mock_viral_fade", start, TODAY, { source: "YOUR_PINS" });
    const share = top.body.pins[0].metrics.IMPRESSION / sum(acct);
    expect(share).toBeGreaterThan(0.5);
    const per = await pinDaily("mock_viral_fade", [top.body.pins[0].pin_id], start, TODAY, "IMPRESSION");
    const daily: Daily = per.get(top.body.pins[0].pin_id).all.daily_metrics;
    const ready = daily.slice(0, idx(2) + 1);
    let peak = 0;
    ready.forEach((x, i) => {
      if ((x.metrics.IMPRESSION ?? 0) > (ready[peak].metrics.IMPRESSION ?? 0)) peak = i;
    });
    expect(peak).toBeGreaterThanOrEqual(idx(33));
    expect(peak).toBeLessThanOrEqual(idx(27));
    for (let i = peak + 7; i + 7 <= ready.length; i += 7) {
      expect(mean(ready, "IMPRESSION", i, i + 7)).toBeLessThan(mean(ready, "IMPRESSION", i - 7, i));
    }
  });

  it("agency clients are healthy-ish (no cliff)", async () => {
    for (const u of ["mock_agency_client_1", "mock_agency_client_2"]) {
      const d = await accountDaily(u, start, TODAY);
      const ratio = mean(d, "IMPRESSION", idx(14), idx(2)) / mean(d, "IMPRESSION", idx(60), idx(30));
      expect(ratio, u).toBeGreaterThan(0.8);
      expect(ratio, u).toBeLessThan(1.3);
    }
  });
});
