import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TODAY, admin, daysAgo, get, login, startEnv, validateComponent, type Env } from "./helpers.ts";

let env: Env;
let clock = Date.parse("2026-11-08T12:00:00Z");
beforeAll(async () => {
  env = await startEnv({ now: () => clock, rateAnalyticsPerMin: 5, rateReadPerMin: 8 });
});
afterAll(() => env.close());

const analytics = { start_date: daysAgo(6), end_date: TODAY, metric_types: "IMPRESSION" };

describe("rate limiting", () => {
  it("sends x-ratelimit-* headers on every API response and 429s after the limit", async () => {
    const { access_token: t } = await login(env.api, "mock_healthy");
    for (let i = 1; i <= 5; i++) {
      const r = await get(env.api, t, "/v5/user_account/analytics", analytics);
      expect(r.status).toBe(200);
      expect(r.headers.get("x-ratelimit-limit")).toBe("5");
      expect(r.headers.get("x-ratelimit-remaining")).toBe(String(5 - i));
      const reset = Number(r.headers.get("x-ratelimit-reset"));
      expect(reset).toBeGreaterThan(0);
      expect(reset).toBeLessThanOrEqual(60);
    }
    const limited = await get(env.api, t, "/v5/user_account/analytics/top_pins", { ...analytics, sort_by: "IMPRESSION" });
    expect(limited.status).toBe(429);
    expect(validateComponent("Pinterest.Lib.Error", limited.body)).toEqual([]);
    expect(limited.headers.get("x-ratelimit-remaining")).toBe("0");
    // org_read is a separate bucket
    const read = await get(env.api, t, "/v5/user_account");
    expect(read.status).toBe(200);
    expect(read.headers.get("x-ratelimit-limit")).toBe("8");
    expect(read.headers.get("x-ratelimit-remaining")).toBe("7");
    // per token: another token has its own budget
    const { access_token: t2 } = await login(env.api, "mock_healthy");
    expect((await get(env.api, t2, "/v5/user_account/analytics", analytics)).status).toBe(200);
    // errors carry headers too
    const unauth = await get(env.api, "pina_bogus", "/v5/pins");
    expect(unauth.status).toBe(401);
    expect(unauth.headers.get("x-ratelimit-limit")).toBe("8");
    // reset semantics: seconds until the 60 s window ends
    clock += 45_000;
    const after45 = await get(env.api, t, "/v5/user_account/analytics", analytics);
    expect(after45.status).toBe(429);
    expect(after45.headers.get("x-ratelimit-reset")).toBe("15");
    clock += 15_000;
    const fresh = await get(env.api, t, "/v5/user_account/analytics", analytics);
    expect(fresh.status).toBe(200);
    expect(fresh.headers.get("x-ratelimit-remaining")).toBe("4");
    expect(fresh.headers.get("x-ratelimit-reset")).toBe("60");
  });

  it("pins list counts against org_read; top_pins and pin analytics against org_analytics", async () => {
    const { access_token: t } = await login(env.api, "mock_viral_fade");
    for (let i = 0; i < 8; i++) expect((await get(env.api, t, "/v5/pins")).status).toBe(200);
    expect((await get(env.api, t, "/v5/boards")).status).toBe(429);
    const pin = "813906000000000001";
    const pa = await get(env.api, t, `/v5/pins/${pin}/analytics`, analytics);
    expect(pa.headers.get("x-ratelimit-limit")).toBe("5");
  });
});

describe("fault injection", () => {
  it("MOCK_FAULT_RATE injects 500/503 deterministically by seed", async () => {
    const run = async () => {
      const e = await startEnv({ faultRate: 0.3, seed: 7 });
      try {
        const { access_token: t } = await login(e.api, "mock_healthy");
        const statuses: number[] = [];
        for (let i = 0; i < 40; i++) statuses.push((await get(e.api, t, "/v5/user_account")).status);
        return statuses;
      } finally {
        await e.close();
      }
    };
    const a = await run();
    const b = await run();
    expect(a).toEqual(b);
    expect(a.filter((s) => s === 500 || s === 503).length).toBeGreaterThan(3);
    expect(a.filter((s) => s === 200).length).toBeGreaterThan(15);
    expect(new Set(a.filter((s) => s !== 200))).toEqual(new Set([500, 503]));
  });

  it("POST /__mock/fault changes the rate at runtime", async () => {
    const { access_token: t } = await login(env.api, "mock_healthy");
    await admin(env.api, "/__mock/reset");
    const t2 = (await login(env.api, "mock_healthy")).access_token;
    expect((await admin(env.api, "/__mock/fault", { rate: 1 })).body.fault_rate).toBe(1);
    const r = await get(env.api, t2, "/v5/user_account");
    expect([500, 503]).toContain(r.status);
    expect(validateComponent("Pinterest.Lib.Error", r.body)).toEqual([]);
    expect(r.headers.get("x-ratelimit-limit")).toBeTruthy();
    expect((await admin(env.api, "/__mock/fault", { rate: 2 })).status).toBe(400);
    await admin(env.api, "/__mock/fault", { rate: 0 });
    expect((await get(env.api, t2, "/v5/user_account")).status).toBe(200);
    expect((await get(env.api, t, "/v5/user_account")).status).toBe(401); // reset cleared tokens
  });
});
