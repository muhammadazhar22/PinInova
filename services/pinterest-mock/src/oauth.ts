/**
 * MOCK OAuth 2.0 authorization-code flow mirroring
 * https://developers.pinterest.com/docs/getting-started/authentication-and-scopes/
 * (consent page, single-use 10-minute codes, 30-day access tokens, continuous 60-day refresh
 * tokens that rotate on every refresh).
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { ACCOUNTS } from "./catalog.ts";

export const ACCESS_TOKEN_TTL_S = 2_592_000; // 30 days
export const REFRESH_TOKEN_TTL_S = 5_184_000; // 60 days
export const CODE_TTL_MS = 10 * 60 * 1000;

export interface CodeRec {
  clientId: string;
  redirectUri: string;
  username: string;
  scope: string;
  expiresAt: number;
  used: boolean;
}

export interface AccessRec {
  token: string;
  username: string;
  scope: string;
  clientId: string;
  issuedAt: number;
  expiresAt: number;
  revoked: boolean;
  forcedExpired: boolean;
}

export interface RefreshRec {
  token: string;
  username: string;
  scope: string;
  clientId: string;
  expiresAt: number;
  valid: boolean;
  /** Why it became invalid. */
  invalidReason?: "rotated" | "revoked";
}

export type AuthResult = { ok: true; rec: AccessRec } | { ok: false; reason: "missing" | "unknown" | "expired" | "revoked" };

function rand(n = 24): string {
  return randomBytes(n).toString("base64url");
}

/** Normalise "a,b c" -> ["a","b","c"]. Pinterest documents comma-separated scopes. */
export function parseScopes(s: string | null | undefined): string[] {
  return (s ?? "")
    .split(/[\s,]+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

export class OAuthStore {
  codes = new Map<string, CodeRec>();
  access = new Map<string, AccessRec>();
  refresh = new Map<string, RefreshRec>();
  revocations: { username: string; at: number }[] = [];

  /**
   * `stateFile` (MOCK_STATE_FILE): persist access/refresh tokens and revocations so they survive a restart of the
   * local stack (SPEC-078). Mock tokens only; authorization codes stay in memory (they live 10 minutes).
   */
  constructor(private now: () => number, private stateFile?: string | null) {
    if (stateFile && existsSync(stateFile)) {
      try {
        const st = JSON.parse(readFileSync(stateFile, "utf8")) as { access?: AccessRec[]; refresh?: RefreshRec[]; revocations?: { username: string; at: number }[] };
        for (const a of st.access ?? []) this.access.set(a.token, a);
        for (const r of st.refresh ?? []) this.refresh.set(r.token, r);
        this.revocations = st.revocations ?? [];
      } catch {
        // A corrupt or partial file starts empty, exactly like a store without one.
      }
    }
  }

  /** Write the persistent part of the store (no-op without a state file). Atomic: temp file + rename. */
  private save(): void {
    if (!this.stateFile) return;
    mkdirSync(dirname(this.stateFile), { recursive: true });
    const tmp = `${this.stateFile}.tmp`;
    writeFileSync(tmp, JSON.stringify({ access: [...this.access.values()], refresh: [...this.refresh.values()], revocations: this.revocations }));
    renameSync(tmp, this.stateFile);
  }

  reset(): void {
    this.codes.clear();
    this.access.clear();
    this.refresh.clear();
    this.revocations = [];
    this.save();
  }

  issueCode(clientId: string, redirectUri: string, username: string, scope: string): string {
    const code = `mockcode_${rand(18)}`;
    this.codes.set(code, { clientId, redirectUri, username, scope, expiresAt: this.now() + CODE_TTL_MS, used: false });
    return code;
  }

  private issueTokens(username: string, scope: string, clientId: string) {
    const now = this.now();
    const access = `pina_MOCK_${rand()}`;
    const refresh = `pinr_MOCK_${rand()}`;
    this.access.set(access, { token: access, username, scope, clientId, issuedAt: now, expiresAt: now + ACCESS_TOKEN_TTL_S * 1000, revoked: false, forcedExpired: false });
    const refreshExpiresAt = now + REFRESH_TOKEN_TTL_S * 1000;
    this.refresh.set(refresh, { token: refresh, username, scope, clientId, expiresAt: refreshExpiresAt, valid: true });
    this.save(); // also records a rotated refresh token's invalidation, made just before this call
    return { access, refresh, refreshExpiresAt };
  }

  /** Returns the token response body or an error message. */
  exchangeCode(clientId: string, code: string, redirectUri: string): { ok: true; body: Record<string, unknown> } | { ok: false; message: string } {
    const rec = this.codes.get(code);
    if (!rec) return { ok: false, message: "Invalid authorization code." };
    if (rec.used) return { ok: false, message: "Authorization code has already been used." };
    if (this.now() > rec.expiresAt) return { ok: false, message: "Authorization code has expired." };
    if (rec.clientId !== clientId) return { ok: false, message: "Authorization code was issued to a different client." };
    if (rec.redirectUri !== redirectUri) return { ok: false, message: "redirect_uri does not match the authorization request." };
    rec.used = true;
    const t = this.issueTokens(rec.username, rec.scope, clientId);
    return { ok: true, body: this.tokenBody(t, rec.scope, "authorization_code") };
  }

  refreshTokens(clientId: string, refreshToken: string): { ok: true; body: Record<string, unknown> } | { ok: false; message: string } {
    const rec = this.refresh.get(refreshToken);
    if (!rec) return { ok: false, message: "Invalid refresh token." };
    if (!rec.valid) return { ok: false, message: rec.invalidReason === "rotated" ? "Refresh token has already been used (rotated)." : "Refresh token has been revoked." };
    if (this.now() > rec.expiresAt) return { ok: false, message: "Refresh token has expired." };
    if (rec.clientId !== clientId) return { ok: false, message: "Refresh token was issued to a different client." };
    rec.valid = false;
    rec.invalidReason = "rotated";
    const t = this.issueTokens(rec.username, rec.scope, clientId);
    return { ok: true, body: this.tokenBody(t, rec.scope, "refresh_token") };
  }

  private tokenBody(t: { access: string; refresh: string; refreshExpiresAt: number }, scope: string, responseType: string): Record<string, unknown> {
    return {
      access_token: t.access,
      refresh_token: t.refresh,
      response_type: responseType,
      token_type: "bearer",
      expires_in: ACCESS_TOKEN_TTL_S,
      refresh_token_expires_in: REFRESH_TOKEN_TTL_S,
      refresh_token_expires_at: Math.floor(t.refreshExpiresAt / 1000),
      scope,
    };
  }

  authenticate(header: string | undefined): AuthResult {
    const m = /^Bearer\s+(\S+)$/i.exec(header ?? "");
    if (!m) return { ok: false, reason: "missing" };
    const rec = this.access.get(m[1]);
    if (!rec) return { ok: false, reason: "unknown" };
    if (rec.revoked) return { ok: false, reason: "revoked" };
    if (rec.forcedExpired || this.now() > rec.expiresAt) return { ok: false, reason: "expired" };
    return { ok: true, rec };
  }

  expireAccessToken(token: string): boolean {
    const rec = this.access.get(token);
    if (!rec) return false;
    rec.forcedExpired = true;
    this.save();
    return true;
  }

  /** Simulates the user removing the app: every token of that user becomes invalid. */
  revokeUser(username: string): { access: number; refresh: number } {
    let a = 0;
    let r = 0;
    for (const rec of this.access.values()) if (rec.username === username && !rec.revoked) { rec.revoked = true; a++; }
    for (const rec of this.refresh.values()) if (rec.username === username && rec.valid) { rec.valid = false; rec.invalidReason = "revoked"; r++; }
    this.revocations.push({ username, at: this.now() });
    this.save();
    return { access: a, refresh: r };
  }

  snapshot() {
    const now = this.now();
    return {
      codes: [...this.codes.values()].map((c) => ({ username: c.username, used: c.used, expired: now > c.expiresAt, redirect_uri: c.redirectUri })),
      access_tokens: [...this.access.values()].map((a) => ({
        token_prefix: a.token.slice(0, 14),
        username: a.username,
        scope: a.scope,
        state: a.revoked ? "revoked" : a.forcedExpired || now > a.expiresAt ? "expired" : "active",
        expires_at: new Date(a.expiresAt).toISOString(),
      })),
      refresh_tokens: [...this.refresh.values()].map((r) => ({
        token_prefix: r.token.slice(0, 14),
        username: r.username,
        state: r.valid ? (now > r.expiresAt ? "expired" : "active") : r.invalidReason,
        expires_at: new Date(r.expiresAt).toISOString(),
      })),
      revocations: this.revocations.map((x) => ({ username: x.username, at: new Date(x.at).toISOString() })),
    };
  }
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export function consentPage(p: { clientId: string; redirectUri: string; scope: string; state: string }): string {
  const scopes = parseScopes(p.scope);
  const accounts = ACCOUNTS.map(
    (a, i) => `<label class="acct"><input type="radio" name="username" value="${esc(a.username)}"${i === 0 ? " checked" : ""}>
      <b>${esc(a.username)}</b> <span class="sc">${esc(a.scenario)}</span><br><small>${esc(a.summary)}</small></label>`,
  ).join("\n");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>MOCK Pinterest — not the real Pinterest</title>
<meta name="robots" content="noindex">
<style>
body{font-family:system-ui,sans-serif;max-width:760px;margin:24px auto;padding:0 16px;color:#222}
.banner{background:#ffe08a;border:3px dashed #b58900;padding:12px 16px;font-weight:700;margin-bottom:16px}
.acct{display:block;border:1px solid #ddd;border-radius:6px;padding:8px 10px;margin:6px 0}
.sc{font-family:monospace;background:#eee;padding:1px 5px;border-radius:3px}
button{font-size:16px;padding:8px 18px;margin-right:10px}
code{background:#f4f4f4;padding:1px 4px}
</style></head>
<body>
<div class="banner">MOCK Pinterest — not the real Pinterest. This page is served by services/pinterest-mock for PinInova development. All accounts and data are synthetic.</div>
<h1>MOCK Pinterest — not the real Pinterest</h1>
<p>App <code>${esc(p.clientId)}</code> is requesting access to a <b>mock</b> account.</p>
<h2>Requested scopes</h2>
<ul>${scopes.map((s) => `<li><code>${esc(s)}</code></li>`).join("") || "<li><i>(none requested)</i></li>"}</ul>
<form method="post" action="/oauth/consent">
<input type="hidden" name="client_id" value="${esc(p.clientId)}">
<input type="hidden" name="redirect_uri" value="${esc(p.redirectUri)}">
<input type="hidden" name="scope" value="${esc(p.scope)}">
<input type="hidden" name="state" value="${esc(p.state)}">
<h2>Choose a mock account</h2>
${accounts}
<p><button type="submit" name="decision" value="allow">Allow</button>
<button type="submit" name="decision" value="deny">Deny</button></p>
</form>
<p><small>Redirects to <code>${esc(p.redirectUri)}</code></small></p>
</body></html>`;
}

export function errorPage(title: string, message: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>MOCK Pinterest — not the real Pinterest — ${esc(title)}</title></head>
<body style="font-family:system-ui,sans-serif;max-width:700px;margin:24px auto">
<div style="background:#ffe08a;border:3px dashed #b58900;padding:12px;font-weight:700">MOCK Pinterest — not the real Pinterest</div>
<h1>${esc(title)}</h1><p>${esc(message)}</p></body></html>`;
}
