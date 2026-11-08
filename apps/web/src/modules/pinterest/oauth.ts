import { env } from "@/env";
import { PinterestAuthError, PinterestError } from "./errors";
import type { TokenResponse } from "./types";

export function redirectUri() {
  return `${env().APP_URL}/api/pinterest/callback`;
}

export function authorizeUrl(state: string, extra: Record<string, string> = {}) {
  const e = env();
  const u = new URL(e.PINTEREST_OAUTH_BASE);
  u.searchParams.set("client_id", e.PINTEREST_CLIENT_ID);
  u.searchParams.set("redirect_uri", redirectUri());
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", e.PINTEREST_SCOPES);
  u.searchParams.set("state", state);
  for (const [k, v] of Object.entries(extra)) u.searchParams.set(k, v);
  return u.toString();
}

async function tokenRequest(body: Record<string, string>, fetchImpl: typeof fetch = fetch): Promise<TokenResponse> {
  const e = env();
  const res = await fetchImpl(`${e.PINTEREST_API_BASE.replace(/\/$/, "")}/oauth/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${e.PINTEREST_CLIENT_ID}:${e.PINTEREST_CLIENT_SECRET}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams(body).toString(),
  });
  const json = (await res.json().catch(() => ({}))) as TokenResponse & { code?: number; message?: string };
  if (res.status === 401 || res.status === 400) throw new PinterestAuthError(res.status, json.code, json.message ?? "token request rejected");
  if (!res.ok) throw new PinterestError(res.status, json.code, json.message ?? res.statusText, res.status >= 500);
  if (!json.access_token) throw new PinterestError(res.status, undefined, "token response missing access_token");
  return json;
}

export function exchangeCode(code: string, fetchImpl?: typeof fetch) {
  return tokenRequest({ grant_type: "authorization_code", code, redirect_uri: redirectUri() }, fetchImpl);
}

/** Continuous refresh: Pinterest rotates the refresh token on every refresh; persist both atomically. */
export function refreshTokens(refreshToken: string, fetchImpl?: typeof fetch) {
  return tokenRequest({ grant_type: "refresh_token", refresh_token: refreshToken }, fetchImpl);
}
