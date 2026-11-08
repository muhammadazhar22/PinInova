import * as Sentry from "@sentry/nextjs";

/** Next.js instrumentation hook: server-side error reporting and OTel-based tracing via Sentry (SPEC-072). */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { sentryOptions } = await import("@/lib/observability/sentry-options");
  const opts = sentryOptions("web");
  if (opts) Sentry.init(opts);
}

export const onRequestError = Sentry.captureRequestError;
