import { afterEach, describe, expect, it } from "vitest";
import { env, resetEnvCache } from "./env";

const saved = { ...process.env };
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
  resetEnvCache();
});

/** A production config that passes every guard; each test breaks one thing. */
function production(over: Record<string, string | undefined> = {}) {
  Object.assign(process.env, {
    NODE_ENV: "production",
    NEXT_PHASE: "",
    BETTER_AUTH_SECRET: "a".repeat(44),
    TOKEN_KEK_V1: Buffer.alloc(32, 7).toString("base64"),
    ANALYTICS_TOKEN: "b".repeat(43),
    PINTEREST_MODE: "mock",
    BILLING_MODE: "simulated",
  });
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetEnvCache();
}

describe("production config guard", () => {
  it("accepts a complete production config", () => {
    production();
    expect(env().ANALYTICS_TOKEN).toHaveLength(43);
  });

  it("refuses production without an analytics shared secret (SPEC-075)", () => {
    production({ ANALYTICS_TOKEN: undefined });
    expect(() => env()).toThrow(/ANALYTICS_TOKEN/);
  });

  it("refuses a short analytics shared secret", () => {
    production({ ANALYTICS_TOKEN: "short" });
    expect(() => env()).toThrow(/ANALYTICS_TOKEN/);
  });

  it("refuses the dev auth secret and dev KEK", () => {
    production({ BETTER_AUTH_SECRET: undefined });
    expect(() => env()).toThrow(/BETTER_AUTH_SECRET/);
    production({ TOKEN_KEK_V1: undefined });
    expect(() => env()).toThrow(/TOKEN_KEK_V1/);
  });

  it("allows no token outside production (local dev and tests)", () => {
    Object.assign(process.env, { NODE_ENV: "test" });
    delete process.env.ANALYTICS_TOKEN;
    resetEnvCache();
    expect(env().ANALYTICS_TOKEN).toBeUndefined();
  });
});
