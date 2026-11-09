import { env } from "@/env";
import { scrubBreadcrumb, scrubEvent } from "./scrub";

/**
 * Shared Sentry options for the web server and the worker (SPEC-072). Sentry's SDK is built on OpenTelemetry:
 * with SENTRY_TRACES_SAMPLE_RATE > 0, HTTP, fetch and Postgres spans are exported to Sentry as OTel traces.
 * Returns null when SENTRY_DSN is unset (local dev, tests): nothing is sent anywhere.
 */
export function sentryOptions(component: "web" | "worker") {
  const e = env();
  if (!e.SENTRY_DSN) return null;
  return {
    dsn: e.SENTRY_DSN,
    environment: e.SENTRY_ENVIRONMENT,
    release: e.APP_RELEASE,
    sendDefaultPii: false,
    tracesSampleRate: e.SENTRY_TRACES_SAMPLE_RATE,
    maxBreadcrumbs: 30,
    // Mock data is labelled everywhere it appears (CLAUDE.md loop protocol 6), including error reports.
    initialScope: { tags: { component, pinterest_mode: e.PINTEREST_MODE } },
    beforeSend: <T extends object>(ev: T) => scrubEvent(ev as never) as T,
    beforeSendTransaction: <T extends object>(ev: T) => scrubEvent(ev as never) as T,
    // Console breadcrumbs would copy job logs (connection ids, counts) to a third party; drop them.
    beforeBreadcrumb: <B extends { category?: string }>(b: B) => (b.category === "console" ? null : (scrubBreadcrumb(b as never) as B)),
  };
}
