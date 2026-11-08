import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import _Ajv2019 from "ajv/dist/2019.js";
import _addFormats from "ajv-formats";
import { createMockServer, createMockSites, type MockServerOptions, type RunningMock } from "../src/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
export const SPEC_PATH = resolve(here, "../../../fixtures/pinterest/openapi-v5.28.0.json");
export const TODAY = "2026-11-08";
export const SCOPES = "user_accounts:read,pins:read,boards:read";
export const REDIRECT = "http://127.0.0.1:3999/api/pinterest/callback";

// ------------------------------------------------------------------ spec schemas via ajv

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Ajv2019: any = (_Ajv2019 as any).default ?? _Ajv2019;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const addFormats: any = (_addFormats as any).default ?? _addFormats;

type Json = Record<string, unknown>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let spec: any;
export function loadSpec() {
  if (!spec) spec = JSON.parse(readFileSync(SPEC_PATH, "utf8"));
  return spec;
}

/** Names referenced from inside an allOf (they cannot be closed with unevaluatedProperties). */
function allOfMembers(schemas: Json): Set<string> {
  const out = new Set<string>();
  const walk = (o: unknown) => {
    if (Array.isArray(o)) return o.forEach(walk);
    if (o && typeof o === "object") {
      for (const [k, v] of Object.entries(o)) {
        if (k === "allOf" && Array.isArray(v)) for (const m of v) if (m && typeof m === "object" && "$ref" in m) out.add(String((m as Json).$ref).split("/").pop()!);
        walk(v);
      }
    }
  };
  walk(schemas);
  return out;
}

/**
 * Convert OpenAPI 3.0 schema objects to JSON Schema 2019-09:
 * - nullable -> anyOf [..., null]; drop discriminator/example/x-*;
 * - refs point into the "pinterest" document;
 * - strict mode: every object schema with `properties` and no additionalProperties gets
 *   unevaluatedProperties:false, so responses may not contain fields the spec does not define.
 */
function convert(o: unknown, strict: boolean, inAllOf: Set<string>, selfName?: string): unknown {
  if (Array.isArray(o)) return o.map((x) => convert(x, strict, inAllOf));
  if (!o || typeof o !== "object") return o;
  const src = o as Json;
  const out: Json = {};
  for (const [k, v] of Object.entries(src)) {
    if (k === "discriminator" || k === "example" || k === "examples" || k.startsWith("x-") || k === "nullable") continue;
    if (k === "$ref") out.$ref = String(v).replace(/^#\/components\/schemas\//, "pinterest#/components/schemas/");
    else if (k === "properties") out.properties = Object.fromEntries(Object.entries(v as Json).map(([pk, pv]) => [pk, convert(pv, strict, inAllOf)]));
    else out[k] = convert(v, strict, inAllOf);
  }
  if (strict && (src.properties || src.allOf) && src.additionalProperties === undefined && !(selfName && inAllOf.has(selfName))) {
    out.unevaluatedProperties = false;
  }
  if (src.nullable === true) return { anyOf: [out, { type: "null" }] };
  return out;
}

const NON_STRICT = new Set(["Pinterest.Lib.Error"]); // Pinterest adds fields like `detail` to errors

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let ajv: any;
function getAjv() {
  if (ajv) return ajv;
  const s = loadSpec();
  const schemas = s.components.schemas as Json;
  const inAllOf = allOfMembers(schemas);
  const converted: Json = {};
  for (const [name, sch] of Object.entries(schemas)) converted[name] = convert(sch, !NON_STRICT.has(name), inAllOf, name);
  ajv = new Ajv2019({ strict: false, allErrors: true });
  addFormats(ajv);
  ajv.addSchema({ $id: "pinterest", components: { schemas: converted } });
  return ajv;
}

const compiled = new Map<string, (d: unknown) => boolean>();

/** Validate against components.schemas[name]. Returns the ajv errors (empty = valid). */
export function validateComponent(name: string, data: unknown): unknown[] {
  let fn = compiled.get(`c:${name}`);
  if (!fn) {
    fn = getAjv().compile({ $ref: `pinterest#/components/schemas/${name}` });
    compiled.set(`c:${name}`, fn!);
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return fn!(data) ? [] : ((fn as any).errors ?? ["invalid"]);
}

/** Validate against the 200 response schema of a spec path+method (inline or $ref). */
export function validateResponse(path: string, method: string, status: string, data: unknown): unknown[] {
  const key = `r:${method}:${path}:${status}`;
  let fn = compiled.get(key);
  if (!fn) {
    const s = loadSpec();
    const resp = s.paths[path][method].responses[status];
    const schema = resp.content["application/json"].schema;
    const inAllOf = allOfMembers(s.components.schemas);
    fn = getAjv().compile(convert(schema, true, inAllOf));
    compiled.set(key, fn!);
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return fn!(data) ? [] : ((fn as any).errors ?? ["invalid"]);
}

// ------------------------------------------------------------------ servers + client

export interface Env {
  api: RunningMock;
  sites: RunningMock;
  close(): Promise<void>;
}

export async function startEnv(opts: MockServerOptions = {}, sitesOpts: Parameters<typeof createMockSites>[0] = {}): Promise<Env> {
  const sites = await createMockSites({ port: 0, ...sitesOpts });
  const api = await createMockServer({ port: 0, today: TODAY, siteBase: sites.url, rateAnalyticsPerMin: 100_000, rateReadPerMin: 100_000, faultRate: 0, autoConsent: false, seed: 1, ...opts });
  return { api, sites, close: async () => void (await Promise.all([api.close(), sites.close()])) };
}

export function basic(id = "mock-client-id", secret = "mock-client-secret"): string {
  return `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`;
}

export async function authorizeCode(api: RunningMock, username: string, scope = SCOPES, state = "st-123", redirectUri = REDIRECT): Promise<string> {
  const u = new URL(`${api.url}/oauth/`);
  u.search = new URLSearchParams({ client_id: "mock-client-id", redirect_uri: redirectUri, response_type: "code", scope, state, mock_user: username }).toString();
  const r = await fetch(u, { redirect: "manual" });
  if (r.status !== 302) throw new Error(`authorize: expected 302, got ${r.status}`);
  const loc = new URL(r.headers.get("location")!);
  if (loc.searchParams.get("state") !== state) throw new Error("state mismatch");
  return loc.searchParams.get("code")!;
}

export async function tokenRequest(api: RunningMock, form: Record<string, string>, auth = basic()): Promise<{ status: number; body: Json; headers: Headers }> {
  const r = await fetch(`${api.url}/v5/oauth/token`, {
    method: "POST",
    headers: { authorization: auth, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
  });
  return { status: r.status, body: (await r.json()) as Json, headers: r.headers };
}

export async function login(api: RunningMock, username: string, scope = SCOPES): Promise<{ access_token: string; refresh_token: string }> {
  const code = await authorizeCode(api, username, scope);
  const t = await tokenRequest(api, { grant_type: "authorization_code", code, redirect_uri: REDIRECT });
  if (t.status !== 200) throw new Error(`token exchange failed: ${JSON.stringify(t.body)}`);
  return t.body as { access_token: string; refresh_token: string };
}

export async function get(api: RunningMock, token: string | null, path: string, query: Record<string, string | number | boolean> = {}): Promise<{ status: number; body: any; headers: Headers }> {
  const u = new URL(`${api.url}${path}`);
  for (const [k, v] of Object.entries(query)) u.searchParams.set(k, String(v));
  const r = await fetch(u, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : null, headers: r.headers };
}

export async function admin(api: RunningMock, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const r = await fetch(`${api.url}${path}`, body === undefined && path.endsWith("state") ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });
  return { status: r.status, body: await r.json() };
}

/** Date helpers relative to TODAY. */
export function daysAgo(n: number, today = TODAY): string {
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}
