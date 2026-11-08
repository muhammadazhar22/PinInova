import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SPLIT_KEYS } from "../src/index.ts";
import { TODAY, daysAgo, get, login, startEnv, validateComponent, validateResponse, type Env } from "./helpers.ts";

let env: Env;
let token: string;
let otherToken: string;
beforeAll(async () => {
  env = await startEnv();
  token = (await login(env.api, "mock_healthy")).access_token;
  otherToken = (await login(env.api, "mock_viral_fade")).access_token;
});
afterAll(() => env.close());

const window30 = { start_date: daysAgo(29), end_date: TODAY };

describe("user_account + websites + boards", () => {
  it("GET /v5/user_account matches the Account schema", async () => {
    const r = await get(env.api, token, "/v5/user_account");
    expect(r.status).toBe(200);
    expect(validateComponent("Account", r.body)).toEqual([]);
    expect(r.body).toMatchObject({ username: "mock_healthy", account_type: "BUSINESS" });
    expect(r.headers.get("x-mock-pinterest")).toMatch(/NOT the real Pinterest/);
  });

  it("GET /v5/user_account/websites lists mock site URLs with claim status", async () => {
    const r = await get(env.api, token, "/v5/user_account/websites");
    expect(validateResponse("/user_account/websites", "get", "200", r.body)).toEqual([]);
    expect(r.body.items.map((i: { website: string }) => i.website)).toEqual([`${env.sites.url}/cozy-kitchen`, `${env.sites.url}/garden-notes`]);
    expect(r.body.items.every((i: { status: string }) => i.status === "verified")).toBe(true);
    const db = await login(env.api, "mock_domain_block");
    const w = await get(env.api, db.access_token, "/v5/user_account/websites");
    expect(w.body.items.map((i: { status: string }) => i.status)).toEqual(["verified", "verified", "unverified"]);
    expect(w.body.items[2].verified_at).toBeUndefined();
  });

  it("GET /v5/boards paginates and matches the spec", async () => {
    const seen: string[] = [];
    let bookmark: string | null = null;
    do {
      const r = await get(env.api, token, "/v5/boards", { page_size: 2, ...(bookmark ? { bookmark } : {}) });
      expect(r.status).toBe(200);
      expect(validateResponse("/boards", "get", "200", r.body)).toEqual([]);
      expect(r.body.items.length).toBeLessThanOrEqual(2);
      seen.push(...r.body.items.map((b: { id: string }) => b.id));
      bookmark = r.body.bookmark;
    } while (bookmark);
    expect(seen.length).toBe(6);
    expect(new Set(seen).size).toBe(6);
    expect((await get(env.api, token, "/v5/boards", { privacy: "SECRET" })).body.items).toEqual([]);
    expect((await get(env.api, token, "/v5/boards", { bookmark: "garbage" })).status).toBe(400);
  });
});

describe("pins", () => {
  it("lists every Pin once across bookmark pages, newest first, schema-valid", async () => {
    const ids: string[] = [];
    const created: string[] = [];
    let bookmark: string | null = null;
    let pages = 0;
    do {
      const r = await get(env.api, token, "/v5/pins", { page_size: 100, ...(bookmark ? { bookmark } : {}) });
      expect(r.status).toBe(200);
      expect(validateResponse("/pins", "get", "200", r.body)).toEqual([]);
      for (const p of r.body.items) {
        ids.push(p.id);
        created.push(p.created_at);
        expect(p.pin_metrics).toBeNull();
      }
      bookmark = r.body.bookmark;
      pages++;
    } while (bookmark);
    const me = await get(env.api, token, "/v5/user_account");
    expect(ids.length).toBe(me.body.pin_count);
    expect(new Set(ids).size).toBe(ids.length);
    expect(pages).toBe(Math.ceil(ids.length / 100));
    expect([...created].sort().reverse()).toEqual(created);
  });

  it("page_size is capped at 250", async () => {
    expect((await get(env.api, token, "/v5/pins", { page_size: 251 })).status).toBe(400);
    const r = await get(env.api, token, "/v5/pins", { page_size: 250 });
    expect(r.body.items.length).toBe(250);
    expect(r.body.bookmark).toBeTypeOf("string");
    expect((await get(env.api, token, "/v5/pins")).body.items.length).toBe(25);
  });

  it("pin_metrics=true adds 90d + lifetime metrics", async () => {
    const r = await get(env.api, token, "/v5/pins", { page_size: 5, pin_metrics: true });
    expect(validateResponse("/pins", "get", "200", r.body)).toEqual([]);
    const pm = r.body.items[0].pin_metrics;
    expect(Object.keys(pm).sort()).toEqual(["90d", "lifetime_metrics"]);
    expect(Object.keys(pm["90d"]).sort()).toEqual(["clickthrough", "impression", "pin_click"]);
    expect(Object.keys(pm.lifetime_metrics).sort()).toEqual(["clickthrough", "comment", "impression", "pin_click", "reaction"]);
    expect(pm.lifetime_metrics.impression).toBeGreaterThanOrEqual(pm["90d"].impression);
  });

  it("links point at the mock sites server, images at /__img, some Pins have no link", async () => {
    const r = await get(env.api, token, "/v5/pins", { page_size: 250 });
    const links = r.body.items.map((p: { link: string | null }) => p.link);
    expect(links.some((l: string | null) => l === null)).toBe(true);
    for (const l of links.filter(Boolean)) expect(l.startsWith(`${env.sites.url}/`)).toBe(true);
    const p = r.body.items[0];
    expect(p.media.images["600x"].url).toBe(`${env.api.url}/__img/${p.id}.png`);
    const domains = await get(env.api, token, "/v5/pins", { page_size: 250, domain: "garden-notes" });
    expect(domains.body.items.length).toBeGreaterThan(0);
    expect(domains.body.items.every((x: { link: string }) => x.link.includes("/garden-notes/"))).toBe(true);
  });

  it("GET /v5/pins/{id}: own Pin 200, other account's Pin 403 PINNER_DATA_ACCESS_DENIED, unknown 404", async () => {
    const mine = (await get(env.api, token, "/v5/pins", { page_size: 1 })).body.items[0];
    const one = await get(env.api, token, `/v5/pins/${mine.id}`, { pin_metrics: true });
    expect(one.status).toBe(200);
    expect(validateComponent("Pin", one.body)).toEqual([]);
    expect(one.body.pin_metrics).not.toBeNull();

    const theirs = (await get(env.api, otherToken, "/v5/pins", { page_size: 1 })).body.items[0];
    const denied = await get(env.api, token, `/v5/pins/${theirs.id}`);
    expect(denied.status).toBe(403);
    expect(validateComponent("Pinterest.Lib.Error", denied.body)).toEqual([]);
    expect(denied.body).toMatchObject({ code: 403, message: "PINNER_DATA_ACCESS_DENIED" });
    expect(denied.body.detail).toContain("Your application does not have access to read pinner data.");
    const deniedAnalytics = await get(env.api, token, `/v5/pins/${theirs.id}/analytics`, { ...window30, metric_types: "IMPRESSION" });
    expect(deniedAnalytics.status).toBe(403);

    const missing = await get(env.api, token, "/v5/pins/999999999999999999");
    expect(missing.status).toBe(404);
    expect(validateComponent("Pinterest.Lib.Error", missing.body)).toEqual([]);
  });
});

describe("account analytics", () => {
  it("NO_SPLIT returns {all: {daily_metrics, summary_metrics}} valid against AnalyticsResponse", async () => {
    const r = await get(env.api, token, "/v5/user_account/analytics", window30);
    expect(r.status).toBe(200);
    expect(validateComponent("AnalyticsResponse", r.body)).toEqual([]);
    expect(Object.keys(r.body)).toEqual(["all"]);
    const all = r.body.all;
    expect(all.daily_metrics).toHaveLength(30);
    expect(Object.keys(all.summary_metrics).sort()).toEqual(
      ["ENGAGEMENT", "ENGAGEMENT_RATE", "IMPRESSION", "OUTBOUND_CLICK", "OUTBOUND_CLICK_RATE", "PIN_CLICK", "PIN_CLICK_RATE", "SAVE", "SAVE_RATE"].sort(),
    );
    expect(all.daily_metrics[0].date).toBe(daysAgo(29));
    const sum = all.daily_metrics.reduce((s: number, d: { metrics: { IMPRESSION: number } }) => s + d.metrics.IMPRESSION, 0);
    expect(all.summary_metrics.IMPRESSION).toBe(sum);
  });

  it("last two days are PROCESSING with partially accumulated numbers", async () => {
    const r = await get(env.api, token, "/v5/user_account/analytics", { ...window30, metric_types: "IMPRESSION" });
    const d = r.body.all.daily_metrics;
    expect(d.at(-1)).toMatchObject({ date: TODAY, data_status: "PROCESSING" });
    expect(d.at(-2)).toMatchObject({ date: daysAgo(1), data_status: "PROCESSING" });
    expect(d.at(-3).data_status).toBe("READY");
    const readyAvg = d.slice(-16, -2).reduce((s: number, x: { metrics: { IMPRESSION: number } }) => s + x.metrics.IMPRESSION, 0) / 14;
    expect(d.at(-1).metrics.IMPRESSION).toBeLessThan(readyAvg * 0.45);
    expect(d.at(-2).metrics.IMPRESSION).toBeLessThan(readyAvg * 0.9);
    expect(Object.keys(d[0].metrics)).toEqual(["IMPRESSION"]);
  });

  it.each(["NO_SPLIT", "APP_TYPE", "OWNED_CONTENT", "SOURCE", "PIN_FORMAT"] as const)("split_field=%s keys + schema", async (split) => {
    const r = await get(env.api, token, "/v5/user_account/analytics", { ...window30, split_field: split });
    expect(r.status).toBe(200);
    expect(validateComponent("AnalyticsResponse", r.body)).toEqual([]);
    expect(Object.keys(r.body).sort()).toEqual([...SPLIT_KEYS[split]].sort());
    for (const g of Object.values(r.body) as { daily_metrics: unknown[] }[]) {
      expect(validateComponent("AnalyticsMetricsResponse", g)).toEqual([]);
      expect(g.daily_metrics).toHaveLength(30);
    }
    if (split !== "NO_SPLIT") {
      // groups add up to the unsplit total
      const total = (await get(env.api, token, "/v5/user_account/analytics", { ...window30, metric_types: "IMPRESSION,SAVE,OUTBOUND_CLICK" })).body.all.summary_metrics;
      for (const m of ["IMPRESSION", "SAVE", "OUTBOUND_CLICK"]) {
        const s = (Object.values(r.body) as { summary_metrics: Record<string, number> }[]).reduce((a, g) => a + g.summary_metrics[m], 0);
        expect(s).toBe(total[m]);
      }
    }
  });

  it("honours filters: source, content_type, app_types, pin_format, from_claimed_content", async () => {
    const q = { ...window30, metric_types: "IMPRESSION" };
    const imp = async (extra: Record<string, string>) => (await get(env.api, token, "/v5/user_account/analytics", { ...q, ...extra })).body.all.summary_metrics.IMPRESSION as number;
    const all = await imp({});
    const yours = await imp({ source: "YOUR_PINS" });
    const others = await imp({ source: "OTHER_PINS" });
    expect(yours + others).toBe(all);
    expect(others).toBeGreaterThan(0);
    expect(others).toBeLessThan(all * 0.2);
    expect(await imp({ content_type: "PAID" })).toBe(0);
    expect(await imp({ content_type: "ORGANIC" })).toBe(all);
    const apps = (await Promise.all(["MOBILE", "TABLET", "WEB"].map((a) => imp({ app_types: a })))).reduce((a, b) => a + b, 0);
    expect(apps).toBe(all);
    expect(await imp({ pin_format: "ADS_STANDARD" })).toBe(0);
    const formats = (await Promise.all(["ORGANIC_IMAGE", "ORGANIC_VIDEO", "ORGANIC_PRODUCT"].map((f) => imp({ pin_format: f })))).reduce((a, b) => a + b, 0);
    expect(formats).toBe(all);
    expect((await imp({ from_claimed_content: "CLAIMED" })) + (await imp({ from_claimed_content: "OTHER" }))).toBe(all);
  });

  it("validates required params and the 90-day rules with 400s", async () => {
    const bad = async (q: Record<string, string>) => {
      const r = await get(env.api, token, "/v5/user_account/analytics", q);
      expect(r.status).toBe(400);
      expect(validateComponent("Pinterest.Lib.Error", r.body)).toEqual([]);
      return r.body.message as string;
    };
    await bad({ end_date: TODAY });
    await bad({ start_date: daysAgo(10) });
    await bad({ start_date: "2026-13-01", end_date: TODAY });
    expect(await bad({ start_date: daysAgo(91), end_date: TODAY })).toMatch(/90 days back/);
    expect(await bad({ start_date: daysAgo(5), end_date: daysAgo(6) })).toMatch(/before start_date/);
    await bad({ start_date: daysAgo(10), end_date: TODAY, split_field: "DEVICE" });
    await bad({ start_date: daysAgo(10), end_date: TODAY, metric_types: "IMPRESSION,CLOSEUP" });
    await bad({ start_date: daysAgo(10), end_date: TODAY, app_types: "WATCH" });
    // exactly 90 days back is fine; end_date up to start+90 is fine (future days are omitted)
    const ok = await get(env.api, token, "/v5/user_account/analytics", { start_date: daysAgo(90), end_date: TODAY, metric_types: "IMPRESSION" });
    expect(ok.status).toBe(200);
    expect(ok.body.all.daily_metrics).toHaveLength(91);
    const future = await get(env.api, token, "/v5/user_account/analytics", { start_date: daysAgo(5), end_date: daysAgo(-10), metric_types: "IMPRESSION" });
    expect(future.body.all.daily_metrics).toHaveLength(6);
    expect(await bad({ start_date: daysAgo(10), end_date: daysAgo(-81) })).toMatch(/90 days past/);
  });

  it("rejects ad_account_id (Business Access not mocked)", async () => {
    expect((await get(env.api, token, "/v5/user_account/analytics", { ...window30, ad_account_id: "123" })).status).toBe(400);
  });
});

describe("top_pins + pin analytics", () => {
  it("top_pins: schema, sorting, num_of_pins cap, created_in_last_n_days", async () => {
    const r = await get(env.api, token, "/v5/user_account/analytics/top_pins", { ...window30, sort_by: "IMPRESSION", num_of_pins: 50 });
    expect(r.status).toBe(200);
    expect(validateComponent("TopPinsAnalyticsResponse", r.body)).toEqual([]);
    expect(r.body.sort_by).toBe("IMPRESSION");
    expect(r.body.pins).toHaveLength(50);
    const imps = r.body.pins.map((p: { metrics: { IMPRESSION: number } }) => p.metrics.IMPRESSION);
    expect([...imps].sort((a: number, b: number) => b - a)).toEqual(imps);
    expect(r.body.pins[0].data_status.IMPRESSION).toBe("PROCESSING");
    expect(r.body.date_availability.is_realtime).toBe(true);
    expect((await get(env.api, token, "/v5/user_account/analytics/top_pins", { ...window30, sort_by: "SAVE", num_of_pins: 51 })).status).toBe(400);
    expect((await get(env.api, token, "/v5/user_account/analytics/top_pins", window30)).status).toBe(400);
    const ready = await get(env.api, token, "/v5/user_account/analytics/top_pins", { start_date: daysAgo(30), end_date: daysAgo(2), sort_by: "OUTBOUND_CLICK", metric_types: "IMPRESSION" });
    expect(ready.body.date_availability.is_realtime).toBe(false);
    expect(Object.keys(ready.body.pins[0].metrics).sort()).toEqual(["IMPRESSION", "OUTBOUND_CLICK"]);
    expect(ready.body.pins[0].data_status.OUTBOUND_CLICK).toBe("READY");
    const recent = await get(env.api, token, "/v5/user_account/analytics/top_pins", { ...window30, sort_by: "IMPRESSION", created_in_last_n_days: 30 });
    const pinsList = (await get(env.api, token, "/v5/pins", { page_size: 250 })).body.items;
    const created = new Map(pinsList.map((p: { id: string; created_at: string }) => [p.id, p.created_at]));
    for (const p of recent.body.pins) expect(String(created.get(p.pin_id)).slice(0, 10) >= daysAgo(29)).toBe(true);
  });

  it("pin analytics: required params, NO_SPLIT/APP_TYPE shapes, BEFORE_PIN_CREATED", async () => {
    const pins = (await get(env.api, token, "/v5/pins", { page_size: 250 })).body.items;
    const recent = pins.find((p: { created_at: string }) => p.created_at.slice(0, 10) > daysAgo(20) && p.created_at.slice(0, 10) < daysAgo(3));
    const path = `/v5/pins/${recent.id}/analytics`;
    expect((await get(env.api, token, path, window30)).status).toBe(400); // metric_types required
    expect((await get(env.api, token, path, { end_date: TODAY, metric_types: "IMPRESSION" })).status).toBe(400);
    expect((await get(env.api, token, path, { start_date: daysAgo(91), end_date: TODAY, metric_types: "IMPRESSION" })).status).toBe(400);
    expect((await get(env.api, token, path, { ...window30, metric_types: "ALL", split_field: "APP_TYPE" })).status).toBe(400);

    const r = await get(env.api, token, path, { ...window30, metric_types: "IMPRESSION,SAVE,SAVE_RATE,TOTAL_REACTIONS,TOTAL_COMMENTS" });
    expect(r.status).toBe(200);
    expect(validateComponent("PinAnalyticsResponse", r.body)).toEqual([]);
    expect(Object.keys(r.body)).toEqual(["all"]);
    const daily = r.body.all.daily_metrics;
    expect(daily[0]).toEqual({ date: daysAgo(29), data_status: "BEFORE_PIN_CREATED", metrics: {} });
    expect(daily.at(-1).data_status).toBe("PROCESSING");
    expect(Object.keys(r.body.all.lifetime_metrics).sort()).toEqual(["TOTAL_COMMENTS", "TOTAL_REACTIONS"]);

    const split = await get(env.api, token, path, { ...window30, metric_types: "IMPRESSION", split_field: "APP_TYPE" });
    expect(validateComponent("PinAnalyticsResponse", split.body)).toEqual([]);
    expect(Object.keys(split.body).sort()).toEqual(["MOBILE", "TABLET", "WEB"]);
    const s = (Object.values(split.body) as { summary_metrics: { IMPRESSION: number } }[]).reduce((a, g) => a + g.summary_metrics.IMPRESSION, 0);
    expect(s).toBe(r.body.all.summary_metrics.IMPRESSION);
  });
});

describe("misc", () => {
  it("unknown /v5 routes 404 with the error shape", async () => {
    const r = await get(env.api, token, "/v5/ad_accounts");
    expect(r.status).toBe(404);
    expect(validateComponent("Pinterest.Lib.Error", r.body)).toEqual([]);
  });
});

describe("schema validator self-check", () => {
  it("rejects fields the spec does not define and wrong enum values", async () => {
    const pin = (await get(env.api, token, "/v5/pins", { page_size: 1 })).body.items[0];
    expect(validateComponent("Pin", pin)).toEqual([]);
    expect(validateComponent("Pin", { ...pin, not_in_spec: 1 })).not.toEqual([]);
    expect(validateComponent("Pin", { ...pin, media: { ...pin.media, media_type: "gif" } })).not.toEqual([]);
    const a = (await get(env.api, token, "/v5/user_account/analytics", window30)).body;
    expect(validateComponent("AnalyticsResponse", { all: { ...a.all, extra: [] } })).not.toEqual([]);
    const day = a.all.daily_metrics[0];
    expect(validateComponent("AnalyticsDailyMetrics", { ...day, data_status: "DONE" })).not.toEqual([]);
    expect(validateComponent("Account", { username: "x", surprise: true })).not.toEqual([]);
  });
});
