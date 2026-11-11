import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
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
    DATABASE_URL: "postgres://pinpulse_app:9f8e7d6c5b4a@db.example/pinpulse",
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

  it("refuses the default pinpulse_app password (SPEC-073)", () => {
    production({ DATABASE_URL: "postgres://pinpulse_app:pinpulse_app@db.example/pinpulse" });
    expect(() => env()).toThrow(/pinpulse_app password/);
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

/** Minimal .env reader matching @next/env and `set -a; . .env.local`: KEY=value, inline "  # comment" stripped. */
function readEnvFile(path: string) {
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (m) out[m[1]!] = m[2]!.replace(/\s+#.*$/, "").trim();
  }
  return out;
}

describe("blank values (SPEC-078)", () => {
  it("starts with .env.example copied unchanged, blank placeholders included", () => {
    const example = readEnvFile(fileURLToPath(new URL("../../../.env.example", import.meta.url)));
    expect(example.SENTRY_DSN).toBe("");
    Object.assign(process.env, example, { NODE_ENV: "development" });
    resetEnvCache();
    expect(() => env()).not.toThrow();
  });

  it("treats an empty value as unset, so defaults and optionals apply", () => {
    Object.assign(process.env, { NODE_ENV: "development", SENTRY_DSN: "", SUPPORT_EMAIL: "", REFUND_WINDOW_DAYS: "", CHROME_PATH: "", BETTER_AUTH_SECRET: "" });
    resetEnvCache();
    const e = env();
    expect(e.SENTRY_DSN).toBeUndefined();
    expect(e.SUPPORT_EMAIL).toBeUndefined();
    expect(e.REFUND_WINDOW_DAYS).toBeUndefined();
    expect(e.CHROME_PATH).toBe("/usr/bin/google-chrome");
  });

  it("still refuses production when a required secret is blank", () => {
    production({ BETTER_AUTH_SECRET: "" });
    expect(() => env()).toThrow(/BETTER_AUTH_SECRET/);
    production({ TOKEN_KEK_V1: "" });
    expect(() => env()).toThrow(/TOKEN_KEK_V1/);
    production({ ANALYTICS_TOKEN: "" });
    expect(() => env()).toThrow(/ANALYTICS_TOKEN/);
  });
});
