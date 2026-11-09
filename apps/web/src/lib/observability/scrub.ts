import { redact } from "@/lib/crypto/vault";

/**
 * Scrubbing for everything sent to Sentry (SPEC-072). Sentry is a third party: it must never receive Pinterest
 * data, OAuth codes or tokens, capability links (consent / share / invite / revoke), cookies, request bodies or
 * user e-mail/IP. Only the error, a scrubbed URL, the user id and trace ids leave the server.
 */
const TOKEN_PATHS = /(\/(?:api\/)?(?:consent|r|invite|revoke)\/)[^/?#]{8,}/g;
const KEEP_HEADERS = new Set(["user-agent", "content-type", "accept"]);
const KEEP_CONTEXTS = new Set(["trace", "runtime", "os", "app", "device", "cloud_resource"]);

export function scrubUrl(url: string): string {
  return url.replace(/[?#].*$/, "").replace(TOKEN_PATHS, "$1[token]");
}

type Crumb = { message?: string; data?: Record<string, unknown> } & Record<string, unknown>;
type Ev = {
  message?: string;
  request?: { url?: string; headers?: Record<string, string> } & Record<string, unknown>;
  user?: { id?: string | number } & Record<string, unknown>;
  exception?: { values?: { value?: string }[] };
  breadcrumbs?: Crumb[];
  extra?: unknown;
  contexts?: Record<string, unknown>;
  transaction?: string;
};

export function scrubBreadcrumb<B extends Crumb>(b: B): B {
  const out = { ...b };
  if (typeof out.message === "string") out.message = redact(out.message);
  if (out.data) {
    const d: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(out.data)) {
      if (k === "url" && typeof v === "string") d.url = scrubUrl(v);
      else if (["method", "status_code", "reason"].includes(k)) d[k] = v;
    }
    out.data = d;
  }
  return out;
}

export function scrubEvent<E extends Ev>(event: E): E {
  const e = { ...event };
  if (typeof e.message === "string") e.message = redact(e.message);
  if (typeof e.transaction === "string") e.transaction = scrubUrl(e.transaction);
  if (e.request) {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(e.request.headers ?? {})) if (KEEP_HEADERS.has(k.toLowerCase())) headers[k] = v;
    e.request = { ...(e.request.url ? { url: scrubUrl(e.request.url) } : {}), headers } as E["request"];
  }
  if (e.user) e.user = (e.user.id !== undefined ? { id: e.user.id } : {}) as E["user"];
  if (e.exception?.values) e.exception = { ...e.exception, values: e.exception.values.map((v) => ({ ...v, ...(v.value ? { value: redact(v.value) } : {}) })) };
  if (e.breadcrumbs) e.breadcrumbs = e.breadcrumbs.map(scrubBreadcrumb);
  delete e.extra;
  if (e.contexts) e.contexts = Object.fromEntries(Object.entries(e.contexts).filter(([k]) => KEEP_CONTEXTS.has(k)));
  return e;
}
