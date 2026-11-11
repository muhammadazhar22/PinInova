/**
 * MOCK Pinterest API v5 server (node:http). NOT Pinterest. All data is synthetic.
 * Shapes follow fixtures/pinterest/openapi-v5.28.0.json; mock-only behaviour is documented in README.md.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { ACCOUNT_BY_USERNAME, ACCOUNTS, DEFAULT_AUTO_CONSENT_USER, SITE_BY_SLUG } from "./catalog.ts";
import { connectableBase, resolveServerConfig, type MockServerOptions, type ResolvedConfig } from "./config.ts";
import { HISTORY_DAYS, N_BASE, getDataset, type AccountData, type Dataset, type PinRec } from "./data.ts";
import { DAY_MS, formatDay, parseIsoDate, todayUtcDayNumber } from "./dates.ts";
import {
  ACCOUNT_METRIC_TYPES,
  APP_TYPES,
  CONTENT_TYPES,
  FROM_CLAIMED,
  PIN_FORMATS,
  PIN_METRIC_TYPES,
  SOURCES,
  SPLIT_FIELDS,
  STANDARD_PIN_METRIC_TYPES,
  TOP_PINS_SORT_BY,
  VIDEO_PIN_METRIC_TYPES,
  accountAnalytics,
  pinAnalytics,
  pinMetricsObject,
  topPins,
  type AccountFilters,
  type AppTypeFilter,
  type SplitField,
} from "./metrics.ts";
import { OAuthStore, consentPage, errorPage, parseScopes } from "./oauth.ts";
import { imagePng } from "./png.ts";
import { RateLimiter, type RateCategory } from "./ratelimit.ts";
import { hashN, mulberry32 } from "./rng.ts";

export interface RunningMock {
  url: string;
  port: number;
  close(): Promise<void>;
}

const MOCK_HEADER = "x-mock-pinterest";
const MOCK_HEADER_VALUE = "true; synthetic data; this is NOT the real Pinterest API";

export const PINNER_DATA_ACCESS_DENIED = {
  code: 403,
  message: "PINNER_DATA_ACCESS_DENIED",
  detail: "Your application does not have access to read pinner data. Your application must be approved for pinner data access.",
};

class ApiError extends Error {
  constructor(
    public status: number,
    public body: Record<string, unknown>,
  ) {
    super(String(body.message));
  }
}
const invalid = (message: string) => new ApiError(400, { code: 1, message });

// ------------------------------------------------------------------ http helpers

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string | number> = {}): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(payload), [MOCK_HEADER]: MOCK_HEADER_VALUE, ...headers });
  res.end(payload);
}

function sendHtml(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", [MOCK_HEADER]: MOCK_HEADER_VALUE, "cache-control": "no-store" });
  res.end(html);
}

function redirect(res: ServerResponse, location: string): void {
  res.writeHead(302, { location, [MOCK_HEADER]: MOCK_HEADER_VALUE, "cache-control": "no-store" });
  res.end();
}

async function readBody(req: IncomingMessage, limit = 1_000_000): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw new ApiError(413, { code: 1, message: "Request body too large." });
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readBody(req);
  if (!raw.trim()) return {};
  try {
    const v = JSON.parse(raw);
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch {
    /* fallthrough */
  }
  throw invalid("Body must be a JSON object.");
}

// ------------------------------------------------------------------ param parsing

function listParam(q: URLSearchParams, name: string): string[] | null {
  const all = q.getAll(name).flatMap((v) => v.split(","));
  const vals = all.map((v) => v.trim()).filter(Boolean);
  return vals.length ? [...new Set(vals)] : null;
}

function enumParam<T extends string>(q: URLSearchParams, name: string, allowed: readonly T[], def: T): T {
  const v = q.get(name);
  if (v === null || v === "") return def;
  if (!(allowed as readonly string[]).includes(v)) throw invalid(`Invalid ${name}: "${v}". Expected one of ${allowed.join(", ")}.`);
  return v as T;
}

function boolParam(q: URLSearchParams, name: string, def = false): boolean {
  const v = q.get(name);
  if (v === null || v === "") return def;
  if (v === "true") return true;
  if (v === "false") return false;
  throw invalid(`Invalid ${name}: "${v}". Expected true or false.`);
}

function intParam(q: URLSearchParams, name: string, def: number, min: number, max: number): number {
  const v = q.get(name);
  if (v === null || v === "") return def;
  if (!/^-?\d+$/.test(v)) throw invalid(`Invalid ${name}: "${v}". Expected an integer.`);
  const n = Number(v);
  if (n < min || n > max) throw invalid(`Invalid ${name}: ${n}. Must be between ${min} and ${max}.`);
  return n;
}

function dateParam(q: URLSearchParams, name: string): number {
  const v = q.get(name);
  if (v === null || v === "") throw invalid(`Missing required parameter: ${name}.`);
  const d = parseIsoDate(v);
  if (d === null) throw invalid(`Invalid ${name}: "${v}". Expected YYYY-MM-DD.`);
  return d;
}

/** 90-day rules shared by all analytics endpoints. */
function dateWindow(q: URLSearchParams, ds: Dataset): { startDay: number; endDay: number } {
  const startDay = dateParam(q, "start_date");
  const endDay = dateParam(q, "end_date");
  if (startDay < ds.today - 90) throw invalid(`start_date cannot be more than 90 days back from today (${formatDay(ds.today)}); earliest allowed is ${formatDay(ds.today - 90)}.`);
  if (endDay < startDay) throw invalid("end_date cannot be before start_date.");
  if (endDay > startDay + 90) throw invalid("end_date cannot be more than 90 days past start_date.");
  return { startDay, endDay };
}

function metricList(q: URLSearchParams, allowed: readonly string[], required: boolean, extra: readonly string[] = []): string[] | null {
  const vals = listParam(q, "metric_types");
  if (!vals) {
    if (required) throw invalid("Missing required parameter: metric_types.");
    return null;
  }
  for (const v of vals) if (!allowed.includes(v) && !extra.includes(v)) throw invalid(`Invalid metric_types value: "${v}".`);
  return vals;
}

function accountFilters(q: URLSearchParams): AccountFilters {
  return {
    appTypes: enumParam(q, "app_types", APP_TYPES, "ALL"),
    pinFormat: enumParam(q, "pin_format", PIN_FORMATS, "ALL"),
    contentType: enumParam(q, "content_type", CONTENT_TYPES, "ALL"),
    source: enumParam(q, "source", SOURCES, "ALL"),
    fromClaimed: enumParam(q, "from_claimed_content", FROM_CLAIMED, "BOTH"),
  };
}

function encodeBookmark(kind: string, acct: AccountData, offset: number): string {
  return Buffer.from(`mock:${kind}:${acct.id}:${offset}`).toString("base64url");
}
function decodeBookmark(q: URLSearchParams, kind: string, acct: AccountData): number {
  const b = q.get("bookmark");
  if (!b) return 0;
  const m = /^mock:([a-z]+):(\d+):(\d+)$/.exec(Buffer.from(b, "base64url").toString("utf8"));
  if (!m || m[1] !== kind || m[2] !== acct.id) throw invalid("Invalid bookmark.");
  return Number(m[3]);
}

// ------------------------------------------------------------------ serializers

interface Ctx {
  cfg: ResolvedConfig;
  ds: Dataset;
  acct: AccountData;
  q: URLSearchParams;
  apiBase: string;
  scopes: string[];
}

function imageUrl(apiBase: string, key: string): string {
  return `${apiBase}/__img/${key}.png`;
}

function pinLink(cfg: ResolvedConfig, pin: PinRec): string | null {
  return pin.linkPath ? `${cfg.siteBase}${pin.linkPath}` : null;
}

function creativeType(pin: PinRec): string {
  return pin.format === "ORGANIC_VIDEO" ? "VIDEO" : "REGULAR";
}

export function serializePin(ctx: Pick<Ctx, "cfg" | "ds" | "apiBase">, acct: AccountData, pin: PinRec, withMetrics: boolean): Record<string, unknown> {
  const url = imageUrl(ctx.apiBase, pin.id);
  const size = { width: 64, height: 64, url };
  const images = { "150x150": size, "400x300": size, "600x": size, "1200x": size };
  const media =
    pin.format === "ORGANIC_VIDEO"
      ? { media_type: "video", cover_image_url: url, video_url: null, video_url_hls: null, duration: 10 + (hashN(pin.imageId, 7) % 50), height: 64, width: 64, images }
      : { media_type: "image", images };
  return {
    id: pin.id,
    created_at: pin.createdAt,
    link: pinLink(ctx.cfg, pin),
    title: pin.title,
    description: pin.description,
    dominant_color: pin.dominantColor,
    alt_text: pin.altText,
    creative_type: creativeType(pin),
    board_id: acct.boards[pin.boardIdx].id,
    board_section_id: null,
    board_owner: { username: acct.def.username },
    is_owner: true,
    is_standard: true,
    is_product: pin.format === "ORGANIC_PRODUCT",
    has_been_promoted: false,
    parent_pin_id: null,
    media,
    pin_metrics: withMetrics ? pinMetricsObject(ctx.ds, acct, pin) : null,
  };
}

function serializeBoard(ctx: Ctx, b: AccountData["boards"][number]): Record<string, unknown> {
  const acct = ctx.acct;
  const pins = b.pinIdxs.map((i) => acct.pins[i]).filter((p) => p.createdDay <= ctx.ds.today);
  const newest = [...pins].sort((a, z) => (a.createdAt < z.createdAt ? 1 : -1));
  return {
    id: b.id,
    name: b.name,
    description: b.description,
    privacy: "PUBLIC",
    created_at: new Date(b.createdDay * DAY_MS + 9 * 3_600_000).toISOString().replace(/\.\d{3}Z$/, "Z"),
    board_pins_modified_at: newest.length ? newest[0].createdAt : new Date(b.createdDay * DAY_MS).toISOString().replace(/\.\d{3}Z$/, "Z"),
    collaborator_count: 0,
    follower_count: b.followerCount,
    pin_count: pins.length,
    owner: { username: acct.def.username },
    media: { image_cover_url: newest.length ? imageUrl(ctx.apiBase, newest[0].id) : null, pin_thumbnail_urls: newest.slice(0, 5).map((p) => imageUrl(ctx.apiBase, p.id)) },
    is_ads_only: false,
  };
}

function monthlyViews(ds: Dataset, acct: AccountData): number {
  let total = 0;
  const from = ds.today - 29 - ds.firstDay;
  for (let p = 0; p < acct.pins.length; p++) {
    const base = p * N_BASE * HISTORY_DAYS; // slot 0 = impressions
    for (let o = from; o < HISTORY_DAYS; o++) total += acct.series[base + o];
  }
  for (let o = from; o < HISTORY_DAYS; o++) total += acct.other[o];
  return total;
}

// ------------------------------------------------------------------ API routes

interface Route {
  method: string;
  pattern: RegExp;
  category: RateCategory;
  scopes: string[];
  handler: (ctx: Ctx, m: RegExpExecArray) => unknown;
}

function listPins(ctx: Ctx): unknown {
  const { q, acct, ds } = ctx;
  const pageSize = intParam(q, "page_size", 25, 1, 250);
  const withMetrics = boolParam(q, "pin_metrics");
  boolParam(q, "include_protected_pins");
  boolParam(q, "include_product_tag_obj");
  const pinFilter = enumParam(q, "pin_filter", ["exclude_native", "exclude_repins", "has_been_promoted"] as const, "exclude_repins");
  const creative = listParam(q, "creative_types");
  const domains = [...(listParam(q, "domains") ?? []), ...(q.get("domain") ? [q.get("domain")!] : [])];
  if ((listParam(q, "domains")?.length ?? 0) > 100) throw invalid("domains accepts at most 100 values.");
  let pins = acct.pins.filter((p) => p.createdDay <= ds.today);
  if (q.has("pin_filter") && pinFilter !== "exclude_repins") pins = []; // every mock Pin is native and unpromoted
  if (creative) pins = pins.filter((p) => creative.includes(creativeType(p)));
  if (domains.length) {
    const siteHost = new URL(ctx.cfg.siteBase).host;
    pins = pins.filter((p) => p.domainSlug && (domains.includes(p.domainSlug) || domains.includes(siteHost) || domains.includes(new URL(ctx.cfg.siteBase).hostname)));
  }
  pins.sort((a, z) => (a.createdAt < z.createdAt ? 1 : a.createdAt > z.createdAt ? -1 : a.id < z.id ? 1 : -1));
  const offset = decodeBookmark(q, "pins", acct);
  const page = pins.slice(offset, offset + pageSize);
  const next = offset + pageSize < pins.length ? encodeBookmark("pins", acct, offset + pageSize) : null;
  return { items: page.map((p) => serializePin(ctx, acct, p, withMetrics)), bookmark: next };
}

function findPin(ctx: Ctx, id: string): PinRec {
  if (!/^\d+$/.test(id)) throw invalid(`Invalid pin_id: "${id}".`);
  const hit = ctx.ds.pinIndex.get(id);
  if (!hit || hit.pin.createdDay > ctx.ds.today) throw new ApiError(404, { code: 50, message: "Pin not found." });
  if (hit.account !== ctx.acct) throw new ApiError(403, { ...PINNER_DATA_ACCESS_DENIED });
  return hit.pin;
}

const ROUTES: Route[] = [
  {
    method: "GET",
    pattern: /^\/v5\/user_account$/,
    category: "org_read",
    scopes: ["user_accounts:read"],
    handler: (ctx) => {
      const { acct, ds, cfg } = ctx;
      return {
        account_type: "BUSINESS",
        id: acct.id,
        username: acct.def.username,
        profile_image: imageUrl(ctx.apiBase, `account-${acct.id}`),
        website_url: `${cfg.siteBase}/${acct.def.domains[0].slug}`,
        about: `MOCK account (${acct.def.scenario}). ${acct.def.summary} Synthetic data, not Pinterest.`,
        business_name: acct.def.businessName,
        board_count: acct.boards.length,
        pin_count: acct.pins.filter((p) => p.createdDay <= ds.today).length,
        follower_count: acct.def.followers,
        following_count: 100 + (hashN(acct.idx, 3) % 400),
        monthly_views: monthlyViews(ds, acct),
      };
    },
  },
  {
    method: "GET",
    pattern: /^\/v5\/user_account\/analytics$/,
    category: "org_analytics",
    scopes: ["user_accounts:read"],
    handler: (ctx) => {
      const { q, ds, acct } = ctx;
      const w = dateWindow(q, ds);
      const filters = accountFilters(q);
      const split = enumParam<SplitField>(q, "split_field", SPLIT_FIELDS, "NO_SPLIT");
      const metrics = metricList(q, ACCOUNT_METRIC_TYPES, false) ?? [...ACCOUNT_METRIC_TYPES];
      return accountAnalytics(ds, acct, { ...w, metrics, split, filters });
    },
  },
  {
    method: "GET",
    pattern: /^\/v5\/user_account\/analytics\/top_pins$/,
    category: "org_analytics",
    scopes: ["pins:read", "user_accounts:read"],
    handler: (ctx) => {
      const { q, ds, acct } = ctx;
      const w = dateWindow(q, ds);
      const sortByRaw = q.get("sort_by");
      if (!sortByRaw) throw invalid("Missing required parameter: sort_by.");
      const sortBy = enumParam(q, "sort_by", TOP_PINS_SORT_BY, "IMPRESSION");
      const numOfPins = intParam(q, "num_of_pins", 10, 1, 50);
      let createdIn: number | null = null;
      if (q.get("created_in_last_n_days")) {
        if (q.get("created_in_last_n_days") !== "30") throw invalid("created_in_last_n_days must be 30.");
        createdIn = 30;
      }
      const metrics = metricList(q, ACCOUNT_METRIC_TYPES, false) ?? [...ACCOUNT_METRIC_TYPES];
      return topPins(ds, acct, { ...w, sortBy, metrics, numOfPins, createdInLastNDays: createdIn, filters: accountFilters(q) });
    },
  },
  { method: "GET", pattern: /^\/v5\/pins$/, category: "org_read", scopes: ["boards:read", "pins:read"], handler: listPins },
  {
    method: "GET",
    pattern: /^\/v5\/pins\/([^/]+)$/,
    category: "org_read",
    scopes: ["boards:read", "pins:read"],
    handler: (ctx, m) => {
      const pin = findPin(ctx, decodeURIComponent(m[1]));
      return serializePin(ctx, ctx.acct, pin, boolParam(ctx.q, "pin_metrics"));
    },
  },
  {
    method: "GET",
    pattern: /^\/v5\/pins\/([^/]+)\/analytics$/,
    category: "org_analytics",
    scopes: ["boards:read", "pins:read"],
    handler: (ctx, m) => {
      const { q, ds, acct } = ctx;
      const pin = findPin(ctx, decodeURIComponent(m[1]));
      const w = dateWindow(q, ds);
      const split = enumParam(q, "split_field", ["NO_SPLIT", "APP_TYPE"] as const, "NO_SPLIT");
      const appTypes = enumParam<AppTypeFilter>(q, "app_types", APP_TYPES, "ALL");
      let metrics = metricList(q, PIN_METRIC_TYPES, true, ["ALL"])!;
      if (metrics.includes("ALL")) {
        if (split !== "NO_SPLIT") throw invalid("metric_types cannot include ALL when split_field is not NO_SPLIT.");
        metrics = [...(pin.format === "ORGANIC_VIDEO" ? VIDEO_PIN_METRIC_TYPES : STANDARD_PIN_METRIC_TYPES)];
      }
      return pinAnalytics(ds, acct, pin, { ...w, metrics, split, appTypes });
    },
  },
  {
    method: "GET",
    pattern: /^\/v5\/boards$/,
    category: "org_read",
    scopes: ["boards:read"],
    handler: (ctx) => {
      const { q, acct } = ctx;
      const pageSize = intParam(q, "page_size", 25, 1, 250);
      const privacy = enumParam(q, "privacy", ["ALL", "PUBLIC", "PROTECTED", "SECRET", "PUBLIC_AND_SECRET"] as const, "ALL");
      const boards = ["ALL", "PUBLIC", "PUBLIC_AND_SECRET"].includes(privacy) ? acct.boards : [];
      const offset = decodeBookmark(q, "boards", acct);
      const page = boards.slice(offset, offset + pageSize);
      return { items: page.map((b) => serializeBoard(ctx, b)), bookmark: offset + pageSize < boards.length ? encodeBookmark("boards", acct, offset + pageSize) : null };
    },
  },
  {
    method: "GET",
    pattern: /^\/v5\/user_account\/websites$/,
    category: "org_read",
    scopes: ["user_accounts:read"],
    handler: (ctx) => {
      const { q, acct, cfg, ds } = ctx;
      const pageSize = intParam(q, "page_size", 25, 1, 250);
      const sites = acct.def.domains.map((d, i) => {
        const item: Record<string, unknown> = { website: `${cfg.siteBase}/${d.slug}`, status: d.status };
        if (d.status === "verified" && !d.omitVerifiedAt) item.verified_at = new Date((ds.firstDay - 60 + i * 11) * DAY_MS + 3_600_000 * (8 + i)).toISOString().replace(/\.\d{3}Z$/, "Z");
        return item;
      });
      const offset = decodeBookmark(q, "websites", acct);
      return { items: sites.slice(offset, offset + pageSize), bookmark: offset + pageSize < sites.length ? encodeBookmark("websites", acct, offset + pageSize) : null };
    },
  },
];

// ------------------------------------------------------------------ server

export async function createMockServer(options: MockServerOptions = {}): Promise<RunningMock> {
  const cfg = resolveServerConfig(options);
  const store = new OAuthStore(cfg.now, cfg.stateFile);
  const limiter = new RateLimiter(cfg.now);
  let faultRate = cfg.faultRate;
  let faultRng = mulberry32(hashN(cfg.seed, 0xfa17));
  let requestCount = 0;
  let faultCount = 0;
  let apiBase = cfg.apiBase ?? "";

  const today = () => cfg.fixedToday ?? todayUtcDayNumber(cfg.now());
  const dataset = () => getDataset(cfg.seed, today());

  function log(method: string, path: string, status: number) {
    if (cfg.log) process.stderr.write(`[MOCK pinterest] ${method} ${path} -> ${status}\n`);
  }

  async function handleAuthorize(req: IncomingMessage, res: ServerResponse, url: URL): Promise<number> {
    const q = url.searchParams;
    const clientId = q.get("client_id") ?? "";
    const redirectUri = q.get("redirect_uri") ?? "";
    const state = q.get("state") ?? "";
    const scope = parseScopes(q.get("scope")).join(",");
    if (clientId !== cfg.clientId) {
      sendHtml(res, 400, errorPage("Invalid client_id", `Unknown client_id "${clientId}".`));
      return 400;
    }
    const redirectErr = checkRedirectUri(redirectUri);
    if (redirectErr) {
      sendHtml(res, 400, errorPage("Invalid redirect_uri", redirectErr));
      return 400;
    }
    if (q.get("response_type") !== "code") {
      redirect(res, withParams(redirectUri, { error: "unsupported_response_type", state }));
      return 302;
    }
    const mockUser = q.get("mock_user");
    if (mockUser !== null || cfg.autoConsent) {
      const username = mockUser || DEFAULT_AUTO_CONSENT_USER;
      if (!ACCOUNT_BY_USERNAME.has(username)) {
        sendHtml(res, 400, errorPage("Unknown mock_user", `No mock account named "${username}". Known: ${ACCOUNTS.map((a) => a.username).join(", ")}`));
        return 400;
      }
      redirect(res, withParams(redirectUri, { code: store.issueCode(clientId, redirectUri, username, scope), state }));
      return 302;
    }
    sendHtml(res, 200, consentPage({ clientId, redirectUri, scope, state }));
    void req;
    return 200;
  }

  async function handleConsent(req: IncomingMessage, res: ServerResponse): Promise<number> {
    const form = new URLSearchParams(await readBody(req));
    const clientId = form.get("client_id") ?? "";
    const redirectUri = form.get("redirect_uri") ?? "";
    const state = form.get("state") ?? "";
    const scope = parseScopes(form.get("scope")).join(",");
    if (clientId !== cfg.clientId) {
      sendHtml(res, 400, errorPage("Invalid client_id", `Unknown client_id "${clientId}".`));
      return 400;
    }
    const redirectErr = checkRedirectUri(redirectUri);
    if (redirectErr) {
      sendHtml(res, 400, errorPage("Invalid redirect_uri", redirectErr));
      return 400;
    }
    if (form.get("decision") !== "allow") {
      redirect(res, withParams(redirectUri, { error: "access_denied", state }));
      return 302;
    }
    const username = form.get("username") ?? "";
    if (!ACCOUNT_BY_USERNAME.has(username)) {
      sendHtml(res, 400, errorPage("Unknown account", `No mock account named "${username}".`));
      return 400;
    }
    redirect(res, withParams(redirectUri, { code: store.issueCode(clientId, redirectUri, username, scope), state }));
    return 302;
  }

  function checkRedirectUri(uri: string): string | null {
    if (!uri) return "Missing redirect_uri.";
    let u: URL;
    try {
      u = new URL(uri);
    } catch {
      return "redirect_uri must be an absolute URL.";
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") return "redirect_uri must use http or https.";
    if (cfg.redirectUris && !cfg.redirectUris.includes(uri)) return `redirect_uri "${uri}" is not registered for this mock app.`;
    return null;
  }

  function rateHeaders(category: RateCategory, key: string): { headers: Record<string, string>; allowed: boolean } {
    const limit = category === "org_analytics" ? cfg.rateAnalyticsPerMin : cfg.rateReadPerMin;
    const st = limiter.hit(`${category}|${key}`, limit);
    return {
      allowed: st.allowed,
      headers: { "x-ratelimit-limit": String(st.limit), "x-ratelimit-remaining": String(st.remaining), "x-ratelimit-reset": String(st.resetSeconds) },
    };
  }

  function maybeFault(): { status: number; body: Record<string, unknown>; headers: Record<string, string> } | null {
    if (faultRate <= 0) return null;
    if (faultRng() >= faultRate) return null;
    faultCount++;
    const status = faultRng() < 0.5 ? 500 : 503;
    return status === 500
      ? { status, body: { code: 500, message: "Internal server error. (MOCK injected fault)" }, headers: {} }
      : { status, body: { code: 503, message: "Service unavailable. (MOCK injected fault)" }, headers: { "retry-after": "1" } };
  }

  async function handleToken(req: IncomingMessage, res: ServerResponse): Promise<number> {
    const auth = /^Basic\s+(\S+)$/i.exec(req.headers.authorization ?? "");
    const decoded = auth ? Buffer.from(auth[1], "base64").toString("utf8") : "";
    const sep = decoded.indexOf(":");
    const clientId = sep >= 0 ? decoded.slice(0, sep) : "";
    const secret = sep >= 0 ? decoded.slice(sep + 1) : "";
    const rl = rateHeaders("org_read", `client:${clientId || "anonymous"}`);
    if (clientId !== cfg.clientId || secret !== cfg.clientSecret) {
      sendJson(res, 401, { code: 2, message: "Authentication failed: invalid client credentials (HTTP Basic client_id:client_secret)." }, rl.headers);
      return 401;
    }
    if (!rl.allowed) {
      sendJson(res, 429, { code: 8, message: "You have exceeded your rate limit. Try again later." }, rl.headers);
      return 429;
    }
    const ctype = (req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
    const raw = await readBody(req);
    if (ctype !== "application/x-www-form-urlencoded") {
      sendJson(res, 400, { code: 1, message: "Content-Type must be application/x-www-form-urlencoded." }, rl.headers);
      return 400;
    }
    const form = new URLSearchParams(raw);
    const grant = form.get("grant_type");
    let result: { ok: true; body: Record<string, unknown> } | { ok: false; message: string };
    if (grant === "authorization_code") {
      const code = form.get("code");
      const redirectUri = form.get("redirect_uri");
      if (!code || !redirectUri) {
        sendJson(res, 400, { code: 1, message: "Missing required parameter: code and redirect_uri are required for grant_type=authorization_code." }, rl.headers);
        return 400;
      }
      result = store.exchangeCode(clientId, code, redirectUri);
    } else if (grant === "refresh_token") {
      const rt = form.get("refresh_token");
      if (!rt) {
        sendJson(res, 400, { code: 1, message: "Missing required parameter: refresh_token." }, rl.headers);
        return 400;
      }
      result = store.refreshTokens(clientId, rt);
    } else if (grant === "client_credentials") {
      sendJson(res, 400, { code: 1, message: "grant_type=client_credentials is not supported by MOCK Pinterest." }, rl.headers);
      return 400;
    } else {
      sendJson(res, 400, { code: 1, message: `Invalid grant_type: "${grant ?? ""}".` }, rl.headers);
      return 400;
    }
    if (!result.ok) {
      sendJson(res, 400, { code: 1, message: result.message }, rl.headers);
      return 400;
    }
    sendJson(res, 200, result.body, { ...rl.headers, "cache-control": "no-store" });
    return 200;
  }

  async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<number> {
    const method = req.method ?? "GET";
    let route: Route | undefined;
    let match: RegExpExecArray | null = null;
    for (const r of ROUTES) {
      const m = r.pattern.exec(url.pathname);
      if (m && r.method === method) {
        route = r;
        match = m;
        break;
      }
    }
    if (!route || !match) {
      const pathKnown = ROUTES.some((r) => r.pattern.test(url.pathname));
      const status = pathKnown ? 405 : 404;
      sendJson(res, status, { code: status, message: pathKnown ? `Method ${method} is not supported by MOCK Pinterest for ${url.pathname}.` : `Not found: ${url.pathname} is not implemented by MOCK Pinterest.` });
      return status;
    }
    const auth = store.authenticate(req.headers.authorization);
    const rawToken = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? "")?.[1] ?? "anonymous";
    const rl = rateHeaders(route.category, auth.ok ? auth.rec.token : rawToken);
    if (!auth.ok) {
      const msg = {
        missing: "Authentication failed.",
        unknown: "Authentication failed.",
        expired: "Authentication failed: access token has expired.",
        revoked: "Authentication failed: access token has been revoked.",
      }[auth.reason];
      sendJson(res, 401, { code: 2, message: msg }, rl.headers);
      return 401;
    }
    if (!rl.allowed) {
      sendJson(res, 429, { code: 8, message: "You have exceeded your rate limit. Try again later." }, rl.headers);
      return 429;
    }
    const fault = maybeFault();
    if (fault) {
      sendJson(res, fault.status, fault.body, { ...rl.headers, ...fault.headers });
      return fault.status;
    }
    const scopes = parseScopes(auth.rec.scope);
    const missing = route.scopes.filter((s) => !scopes.includes(s));
    if (missing.length) {
      sendJson(res, 403, { code: 3, message: `Authorization failed: token is missing required scope(s): ${missing.join(", ")}.` }, rl.headers);
      return 403;
    }
    if (url.searchParams.has("ad_account_id")) {
      sendJson(res, 400, { code: 1, message: "ad_account_id (Business Access) is not supported by MOCK Pinterest; authorize each account directly." }, rl.headers);
      return 400;
    }
    const ds = dataset();
    const acct = ds.byUsername.get(auth.rec.username)!;
    try {
      const body = route.handler({ cfg, ds, acct, q: url.searchParams, apiBase, scopes }, match);
      sendJson(res, 200, body, rl.headers);
      return 200;
    } catch (e) {
      if (e instanceof ApiError) {
        sendJson(res, e.status, e.body, rl.headers);
        return e.status;
      }
      throw e;
    }
  }

  async function handleAdmin(req: IncomingMessage, res: ServerResponse, url: URL): Promise<number> {
    const p = url.pathname;
    const method = req.method ?? "GET";
    const ok = (body: unknown) => {
      sendJson(res, 200, { mock: true, ...(body as object) });
      return 200;
    };
    if (method === "POST" && p === "/__mock/reset") {
      store.reset();
      limiter.reset();
      faultRate = cfg.faultRate;
      faultRng = mulberry32(hashN(cfg.seed, 0xfa17));
      faultCount = 0;
      return ok({ ok: true, fault_rate: faultRate });
    }
    if (method === "POST" && p === "/__mock/expire-access-token") {
      const body = await readJson(req);
      const token = typeof body.access_token === "string" ? body.access_token : "";
      if (!store.expireAccessToken(token)) {
        sendJson(res, 404, { mock: true, code: 404, message: "Unknown access_token." });
        return 404;
      }
      return ok({ ok: true, expired: true });
    }
    if (method === "POST" && p === "/__mock/revoke") {
      const body = await readJson(req);
      const username = typeof body.username === "string" ? body.username : "";
      if (!ACCOUNT_BY_USERNAME.has(username)) {
        sendJson(res, 404, { mock: true, code: 404, message: `Unknown mock username "${username}".` });
        return 404;
      }
      return ok({ ok: true, username, revoked: store.revokeUser(username) });
    }
    if (method === "POST" && p === "/__mock/fault") {
      const body = await readJson(req);
      const rate = Number(body.rate);
      if (!Number.isFinite(rate) || rate < 0 || rate > 1) {
        sendJson(res, 400, { mock: true, code: 1, message: "rate must be a number within 0..1." });
        return 400;
      }
      faultRate = rate;
      return ok({ ok: true, fault_rate: faultRate });
    }
    if (method === "GET" && p === "/__mock/state") {
      const ds = dataset();
      return ok({
        notice: "MOCK Pinterest. Synthetic data. Not the real Pinterest API.",
        seed: cfg.seed,
        today: formatDay(ds.today),
        today_fixed: cfg.fixedToday !== null,
        site_base: cfg.siteBase,
        api_base: apiBase,
        fault_rate: faultRate,
        faults_injected: faultCount,
        requests_handled: requestCount,
        rate_limits_per_min: { org_analytics: cfg.rateAnalyticsPerMin, org_read: cfg.rateReadPerMin },
        rate_limit_windows: limiter.snapshot(),
        auto_consent: cfg.autoConsent,
        oauth: store.snapshot(),
      });
    }
    if (method === "GET" && p === "/__mock/accounts") {
      const ds = dataset();
      return ok({
        notice: "MOCK accounts with synthetic data.",
        accounts: ds.accounts.map((a) => ({
          username: a.def.username,
          id: a.id,
          scenario: a.def.scenario,
          cause: a.def.cause,
          summary: a.def.summary,
          pin_count: a.pins.filter((p) => p.createdDay <= ds.today).length,
          board_count: a.boards.length,
          domains: a.def.domains.map((d) => ({ slug: d.slug, website: `${cfg.siteBase}/${d.slug}`, status: d.status, site_behaviour: SITE_BY_SLUG.get(d.slug)!.behaviour })),
          authorize_url_hint: `${apiBase}/oauth/?client_id=${encodeURIComponent(cfg.clientId)}&redirect_uri=<uri>&response_type=code&scope=user_accounts:read,pins:read,boards:read&state=<state>&mock_user=${a.def.username}`,
        })),
      });
    }
    sendJson(res, 404, { mock: true, code: 404, message: `Unknown admin endpoint ${method} ${p}.` });
    return 404;
  }

  function handleImage(res: ServerResponse, key: string): number {
    const img = dataset().images.get(key);
    if (!img) {
      sendJson(res, 404, { code: 404, message: "Image not found (MOCK)." });
      return 404;
    }
    const buf = imagePng(img.imageId, img.variant);
    res.writeHead(200, { "content-type": "image/png", "content-length": buf.length, "cache-control": "public, max-age=86400", [MOCK_HEADER]: MOCK_HEADER_VALUE });
    res.end(buf);
    return 200;
  }

  const server = createServer((req, res) => {
    requestCount++;
    const url = new URL(req.url ?? "/", "http://mock.local");
    const method = req.method ?? "GET";
    const p = url.pathname;
    const run = async (): Promise<number> => {
      if ((p === "/oauth/" || p === "/oauth") && method === "GET") return handleAuthorize(req, res, url);
      if (p === "/oauth/consent" && method === "POST") return handleConsent(req, res);
      if (p === "/v5/oauth/token") {
        if (method !== "POST") {
          sendJson(res, 405, { code: 405, message: "Use POST for /v5/oauth/token." });
          return 405;
        }
        return handleToken(req, res);
      }
      if (p.startsWith("/v5/")) return handleApi(req, res, url);
      if (p.startsWith("/__mock/")) return handleAdmin(req, res, url);
      const img = /^\/__img\/([A-Za-z0-9-]+)\.png$/.exec(p);
      if (img && method === "GET") return handleImage(res, img[1]);
      if (p === "/" && method === "GET") {
        sendJson(res, 200, {
          mock: true,
          name: "MOCK Pinterest API v5 (PinInova services/pinterest-mock)",
          notice: "This is NOT Pinterest. All accounts and data are synthetic.",
          api_base: `${apiBase}/v5`,
          oauth_authorize: `${apiBase}/oauth/`,
          admin: ["POST /__mock/reset", "POST /__mock/expire-access-token", "POST /__mock/revoke", "POST /__mock/fault", "GET /__mock/state", "GET /__mock/accounts"],
        });
        return 200;
      }
      sendJson(res, 404, { code: 404, message: `Not found: ${p} (MOCK Pinterest).` });
      return 404;
    };
    run()
      .then((status) => log(method, p, status))
      .catch((e: unknown) => {
        const status = e instanceof ApiError ? e.status : 500;
        if (!res.headersSent) sendJson(res, status, e instanceof ApiError ? e.body : { code: 500, message: `MOCK internal error: ${(e as Error)?.message ?? e}` });
        else res.end();
        log(method, p, status);
      });
  });

  // Warm the dataset so the first request is fast.
  dataset();

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(cfg.port, cfg.host, () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  const url = connectableBase(cfg.host, port);
  if (!apiBase) apiBase = url;
  return {
    url,
    port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections?.();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

function withParams(base: string, params: Record<string, string>): string {
  const u = new URL(base);
  for (const [k, v] of Object.entries(params)) if (v !== "") u.searchParams.set(k, v);
  return u.toString();
}

