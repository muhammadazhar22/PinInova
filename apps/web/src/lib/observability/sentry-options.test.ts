import { afterEach, describe, expect, it } from "vitest";
import { resetEnvCache } from "@/env";
import { sentryOptions } from "./sentry-options";

const saved = { ...process.env };
afterEach(() => {
  for (const k of ["SENTRY_DSN", "SENTRY_ENVIRONMENT"]) delete process.env[k];
  Object.assign(process.env, saved);
  resetEnvCache();
});

describe("sentryOptions (SPEC-072)", () => {
  it("is off without a DSN", () => {
    delete process.env.SENTRY_DSN;
    resetEnvCache();
    expect(sentryOptions("web")).toBeNull();
  });

  it("never sends default PII, tags mock mode, scrubs events and drops console breadcrumbs", () => {
    process.env.SENTRY_DSN = "https://public@o1.ingest.sentry.io/1";
    process.env.SENTRY_ENVIRONMENT = "staging";
    resetEnvCache();
    const o = sentryOptions("worker")!;
    expect(o.sendDefaultPii).toBe(false);
    expect(o.environment).toBe("staging");
    expect(o.initialScope.tags).toEqual({ component: "worker", pinterest_mode: "mock" });
    const ev = o.beforeSend({ request: { url: "/consent/abcdefghijklmnop?x=1", headers: { cookie: "s" } } }) as { request: unknown };
    expect(ev.request).toEqual({ url: "/consent/[token]", headers: {} });
    expect(o.beforeBreadcrumb({ category: "console", message: "job.done" })).toBeNull();
  });
});
