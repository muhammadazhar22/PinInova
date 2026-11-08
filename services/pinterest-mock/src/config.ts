import { parseIsoDate } from "./dates.ts";

export interface MockServerOptions {
  /** Port for the mock API (0 = random). Env MOCK_PORT, default 4010. */
  port?: number;
  /** Bind host. Env MOCK_HOST, default 127.0.0.1. */
  host?: string;
  clientId?: string;
  clientSecret?: string;
  /** YYYY-MM-DD. Env MOCK_TODAY; default: the current UTC date (re-evaluated per request). */
  today?: string;
  rateAnalyticsPerMin?: number;
  rateReadPerMin?: number;
  /** 0..1 probability of injecting a 500/503 on /v5 API calls (token endpoint excluded). */
  faultRate?: number;
  autoConsent?: boolean;
  seed?: number;
  /** Base URL of the mock websites server, used inside Pin links. */
  siteBase?: string;
  /** Public base URL of this API server (used in image URLs). Default: the listening URL. */
  apiBase?: string;
  /** Optional allow-list of redirect URIs. Env MOCK_REDIRECT_URIS (comma separated). Default: any http(s) URI. */
  redirectUris?: string[];
  /** Clock override for tests (epoch ms). */
  now?: () => number;
  /** Log one line per request to stderr. Env MOCK_LOG=true. */
  log?: boolean;
}

export interface MockSitesOptions {
  /** Env MOCK_SITE_PORT, default 4011 (0 = random). */
  port?: number;
  host?: string;
  /** Delay for the slow path in ms (default 5000). Env MOCK_SITE_SLOW_MS. */
  slowDelayMs?: number;
  log?: boolean;
}

export interface ResolvedConfig {
  port: number;
  host: string;
  clientId: string;
  clientSecret: string;
  /** Fixed day number, or null = follow the clock. */
  fixedToday: number | null;
  rateAnalyticsPerMin: number;
  rateReadPerMin: number;
  faultRate: number;
  autoConsent: boolean;
  seed: number;
  siteBase: string;
  apiBase: string | null;
  redirectUris: string[] | null;
  now: () => number;
  log: boolean;
}

function envNum(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`[MOCK pinterest] ${name} must be a number, got "${v}"`);
  return n;
}

function envBool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  return v === "true" || v === "1";
}

export function resolveSitePort(opt?: number): number {
  return opt ?? envNum("MOCK_SITE_PORT", 4011);
}

export function resolveServerConfig(o: MockServerOptions = {}): ResolvedConfig {
  const todayStr = o.today ?? process.env.MOCK_TODAY ?? "";
  let fixedToday: number | null = null;
  if (todayStr) {
    fixedToday = parseIsoDate(todayStr);
    if (fixedToday === null) throw new Error(`[MOCK pinterest] MOCK_TODAY must be YYYY-MM-DD, got "${todayStr}"`);
  }
  const sitePort = resolveSitePort();
  const faultRate = o.faultRate ?? envNum("MOCK_FAULT_RATE", 0);
  if (faultRate < 0 || faultRate > 1) throw new Error("[MOCK pinterest] fault rate must be within 0..1");
  const redirect = o.redirectUris ?? (process.env.MOCK_REDIRECT_URIS ? process.env.MOCK_REDIRECT_URIS.split(",").map((s) => s.trim()).filter(Boolean) : null);
  return {
    port: o.port ?? envNum("MOCK_PORT", 4010),
    host: o.host ?? process.env.MOCK_HOST ?? "127.0.0.1",
    clientId: o.clientId ?? process.env.MOCK_CLIENT_ID ?? "mock-client-id",
    clientSecret: o.clientSecret ?? process.env.MOCK_CLIENT_SECRET ?? "mock-client-secret",
    fixedToday,
    rateAnalyticsPerMin: o.rateAnalyticsPerMin ?? envNum("MOCK_RATE_ANALYTICS_PER_MIN", 60),
    rateReadPerMin: o.rateReadPerMin ?? envNum("MOCK_RATE_READ_PER_MIN", 1000),
    faultRate,
    autoConsent: o.autoConsent ?? envBool("MOCK_AUTO_CONSENT", false),
    seed: o.seed ?? envNum("MOCK_SEED", 1),
    siteBase: stripSlash(o.siteBase ?? process.env.MOCK_SITE_BASE ?? `http://127.0.0.1:${sitePort}`),
    apiBase: o.apiBase ? stripSlash(o.apiBase) : process.env.MOCK_API_BASE ? stripSlash(process.env.MOCK_API_BASE) : null,
    redirectUris: redirect,
    now: o.now ?? Date.now,
    log: o.log ?? envBool("MOCK_LOG", false),
  };
}

function stripSlash(s: string): string {
  return s.replace(/\/+$/, "");
}
