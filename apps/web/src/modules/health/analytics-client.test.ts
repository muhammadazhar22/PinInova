import { afterEach, describe, expect, it } from "vitest";
import { resetEnvCache } from "@/env";
import { analytics } from "./analytics-client";

const saved = process.env.ANALYTICS_TOKEN;
afterEach(() => {
  if (saved === undefined) delete process.env.ANALYTICS_TOKEN;
  else process.env.ANALYTICS_TOKEN = saved;
  resetEnvCache();
});

function capture() {
  const calls: { url: string; headers: Headers }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, headers: new Headers(init.headers) });
    return new Response(JSON.stringify({ days: [] }), { status: 200 });
  }) as unknown as typeof fetch;
  return { calls, f };
}

describe("analytics client auth (SPEC-075)", () => {
  it("sends the shared secret as a bearer token", async () => {
    process.env.ANALYTICS_TOKEN = "s".repeat(40);
    resetEnvCache();
    const { calls, f } = capture();
    await analytics.weather([], f);
    expect(calls[0]?.headers.get("authorization")).toBe(`Bearer ${"s".repeat(40)}`);
  });

  it("sends no Authorization header when no token is configured (local dev)", async () => {
    delete process.env.ANALYTICS_TOKEN;
    resetEnvCache();
    const { calls, f } = capture();
    await analytics.weather([], f);
    expect(calls[0]?.headers.has("authorization")).toBe(false);
  });
});
