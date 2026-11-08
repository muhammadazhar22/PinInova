import { describe, expect, it } from "vitest";
import { PinterestClient } from "./client";
import { PinterestAuthError, PinterestError, PinterestForbiddenError } from "./errors";
import { RateGate } from "./rate";

function fakeFetch(responses: Array<{ status: number; body?: unknown; headers?: Record<string, string> }>) {
  const calls: string[] = [];
  const f = (async (url: URL | string) => {
    calls.push(String(url));
    const r = responses.shift() ?? { status: 200, body: {} };
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status, headers: { "content-type": "application/json", ...(r.headers ?? {}) } });
  }) as unknown as typeof fetch;
  return { f, calls };
}

const sleeps: number[] = [];
const sleep = async (ms: number) => {
  sleeps.push(ms);
};

describe("PinterestClient", () => {
  it("retries 5xx with backoff and succeeds", async () => {
    const { f, calls } = fakeFetch([{ status: 503 }, { status: 500 }, { status: 200, body: { username: "x" } }]);
    const c = new PinterestClient({ baseUrl: "http://p/v5", accessToken: "tok", fetchImpl: f, sleep, baseBackoffMs: 10 });
    expect(await c.userAccount()).toEqual({ username: "x" });
    expect(calls).toHaveLength(3);
  });

  it("never retries 401 and redacts tokens", async () => {
    const { f, calls } = fakeFetch([{ status: 401, body: { code: 2, message: "Authentication failed. Bearer pina_secret_abcdefgh" } }]);
    const c = new PinterestClient({ baseUrl: "http://p/v5", accessToken: "pina_secret_abcdefgh", fetchImpl: f, sleep });
    const err = await c.userAccount().catch((e) => e);
    expect(err).toBeInstanceOf(PinterestAuthError);
    expect(err.message).not.toContain("pina_secret_abcdefgh");
    expect(calls).toHaveLength(1);
  });

  it("surfaces 403 access-denied without retry", async () => {
    const { f } = fakeFetch([{ status: 403, body: { code: 403, message: "Your application does not have access to read pinner data." } }]);
    const c = new PinterestClient({ baseUrl: "http://p/v5", accessToken: "t", fetchImpl: f, sleep });
    await expect(c.pinAnalytics("123", { start: "2026-10-01", end: "2026-10-31" })).rejects.toBeInstanceOf(PinterestForbiddenError);
  });

  it("honours 429 reset header before retrying", async () => {
    const { f } = fakeFetch([{ status: 429, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "7" } }, { status: 200, body: { ok: 1 } }]);
    let now = 0;
    const gate = new RateGate(60, () => now);
    const waits: number[] = [];
    const c = new PinterestClient({
      baseUrl: "http://p/v5", accessToken: "t", fetchImpl: f,
      gates: new Map([["org_analytics", gate]]),
      sleep: async (ms) => { waits.push(ms); now += ms; },
    });
    await c.accountAnalytics({ start: "2026-09-01", end: "2026-10-01" });
    expect(waits.some((w) => w >= 7000)).toBe(true);
  });

  it("paginates pins until bookmark is null", async () => {
    const { f, calls } = fakeFetch([
      { status: 200, body: { items: [{ id: "1" }, { id: "2" }], bookmark: "b1" } },
      { status: 200, body: { items: [{ id: "3" }], bookmark: null } },
    ]);
    const c = new PinterestClient({ baseUrl: "http://p/v5", accessToken: "t", fetchImpl: f, sleep });
    const ids: string[] = [];
    for await (const p of c.listPins()) ids.push(p.id);
    expect(ids).toEqual(["1", "2", "3"]);
    expect(calls[1]).toContain("bookmark=b1");
  });

  it("does not retry 400 validation errors", async () => {
    const { f, calls } = fakeFetch([{ status: 400, body: { code: 1, message: "start_date too old" } }]);
    const c = new PinterestClient({ baseUrl: "http://p/v5", accessToken: "t", fetchImpl: f, sleep });
    await expect(c.accountAnalytics({ start: "2025-01-01", end: "2025-02-01" })).rejects.toBeInstanceOf(PinterestError);
    expect(calls).toHaveLength(1);
  });

  it("rejects pin ids that could alter the path", () => {
    const c = new PinterestClient({ baseUrl: "http://p/v5", accessToken: "t", sleep });
    expect(() => c.pinAnalytics("../user_account", { start: "a", end: "b" })).toThrow();
  });
});

describe("RateGate", () => {
  it("spaces calls to the per-minute budget", () => {
    let now = 0;
    const g = new RateGate(60, () => now);
    for (let i = 0; i < 60; i++) expect(g.take()).toBe(0);
    expect(g.take()).toBeGreaterThan(0);
    now += 1000;
    expect(g.take()).toBe(0);
  });
});
