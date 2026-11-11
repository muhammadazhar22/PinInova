import { env } from "@/env";
import { audit } from "@/lib/audit";
import { newDataKey, openSecret, sealSecret, unwrapDataKey } from "@/lib/crypto/vault";
import { db, withWorkspace, type Tx, one } from "@/lib/db";
import { hashToken, newToken, safeEqual } from "@/lib/tokens";
import { entitlements, type Entitlements } from "@/modules/billing/plans";
import { enqueue, QUEUES } from "@/modules/jobs/boss";
import { PinterestClient } from "./client";
import { CONSENT_TEXT_VERSION } from "./consent";
import { PinterestAuthError } from "./errors";
import { authorizeUrl, exchangeCode, refreshTokens } from "./oauth";
import type { RateGate, Category } from "./rate";

export type ConnectErrorReason = "state_invalid" | "denied" | "plan_limit" | "consent_used" | "exchange_failed" | "wrong_browser";

export class ConnectError extends Error {
  constructor(public reason: ConnectErrorReason, message: string) {
    super(message);
  }
}

/** Cookie that binds an OAuth round trip to the browser that started it (login-CSRF / account-injection defence). */
export const OAUTH_NONCE_COOKIE = "pp_oauth_nonce";

/** Only same-site relative paths; rejects //host and /\host. */
export function safeRedirectPath(p: string | null | undefined, fallback = "/app") {
  return p && /^\/(?![\/\\])/.test(p) ? p : fallback;
}

/**
 * Step 1: create a single-use, 10-minute OAuth state bound to a workspace, the starting user (owner flow) or
 * client consent link, AND a browser nonce. The caller must set the nonce as an httpOnly cookie.
 */
export async function startConnect(p: { workspaceId: string; userId: string | null; consentRequestId?: string | null; redirectTo: string; orgId?: string }) {
  if (!p.userId && !p.consentRequestId) throw new Error("startConnect needs a user (owner flow) or a consent request (client flow)");
  const state = newToken();
  const nonce = newToken();
  await withWorkspace(p.workspaceId, (tx) => tx`
    INSERT INTO oauth_state (state_hash, nonce_hash, workspace_id, user_id, consent_request_id, redirect_to, expires_at)
    VALUES (${hashToken(state)}, ${hashToken(nonce)}, ${p.workspaceId}, ${p.userId}, ${p.consentRequestId ?? null}, ${safeRedirectPath(p.redirectTo)}, now() + interval '10 minutes')`);
  return { url: authorizeUrl(state), nonce };
}

/** A reconnect keeps the account count unchanged, so it fits unless the org is already over its limit (or has none). */
function reconnectWithinLimit(ent: Entitlements) {
  return ent.accountLimit > 0 && ent.activeAccounts <= ent.accountLimit;
}

/**
 * May the Connect flow start? `reconnectId` = the Reconnect button of a connection flagged needs_reauth: allowed at the
 * plan limit (SPEC-001), since completing it replaces that connection's tokens instead of adding an account.
 */
export async function connectAllowed(orgId: string, workspaceId: string, reconnectId?: string | null): Promise<{ ok: true } | { ok: false; message: string }> {
  const ent = await entitlements(orgId);
  if (ent.canConnect) return { ok: true };
  if (reconnectId && /^[0-9a-f-]{36}$/i.test(reconnectId) && reconnectWithinLimit(ent)) {
    const [c] = await withWorkspace(workspaceId, (tx) => tx<{ status: string }[]>`SELECT status FROM pinterest_connection WHERE id = ${reconnectId}`);
    if (c?.status === "needs_reauth") return { ok: true };
  }
  return { ok: false, message: `Your plan allows ${ent.accountLimit} connected accounts.` };
}

export interface ConnectResult {
  workspaceId: string;
  connectionId: string;
  redirectTo: string;
  revokeToken: string | null;
  viaClientLink: boolean;
}

/** Step 2: Pinterest redirected back. Validate state, exchange the code, store sealed tokens and a consent record. */
export async function completeConnect(p: { state: string; nonce: string | null | undefined; sessionUserId: string | null | undefined; code?: string | null; error?: string | null; fetchImpl?: typeof fetch }): Promise<ConnectResult> {
  const stateHash = hashToken(p.state);
  const [row] = await db()<{ workspace_id: string }[]>`SELECT * FROM system_workspace_of_oauth_state(${stateHash})`;
  if (!row) throw new ConnectError("state_invalid", "This connection link has expired. Please start again.");
  const workspaceId = row.workspace_id;
  const { org: orgId } = await one(db()<{ org: string }[]>`SELECT system_workspace_org(${workspaceId}::uuid) AS org`);

  // Consume the state first so it can never be replayed, whatever happens next.
  const st = await withWorkspace(workspaceId, async (tx) => {
    const [s] = await tx<{ user_id: string | null; consent_request_id: string | null; redirect_to: string; nonce_hash: Buffer | null }[]>`
      DELETE FROM oauth_state WHERE state_hash = ${stateHash} AND expires_at > now() RETURNING user_id, consent_request_id, redirect_to, nonce_hash`;
    return s;
  });
  if (!st) throw new ConnectError("state_invalid", "This connection link has expired. Please start again.");
  // The round trip must finish in the browser that started it, and the owner flow must finish as the same user.
  if (!p.nonce || !st.nonce_hash || !safeEqual(hashToken(p.nonce), st.nonce_hash)) {
    throw new ConnectError("wrong_browser", "This connection was started in a different browser. Please start again from PinInova.");
  }
  if (st.user_id && st.user_id !== p.sessionUserId) {
    throw new ConnectError("wrong_browser", "Please sign in as the person who started this connection and try again.");
  }
  if (p.error || !p.code) throw new ConnectError("denied", "Pinterest access was not granted.");

  const ent = await entitlements(orgId);
  let tokens;
  try {
    tokens = await exchangeCode(p.code, p.fetchImpl);
  } catch (e) {
    throw new ConnectError("exchange_failed", `Could not complete the Pinterest connection (${(e as Error).message}).`);
  }
  const client = new PinterestClient({ baseUrl: env().PINTEREST_API_BASE, accessToken: tokens.access_token, fetchImpl: p.fetchImpl, maxRetries: 2 });
  const account = await client.userAccount();
  const pinterestUserId = account.id ?? account.username ?? "unknown";
  const scopes = (tokens.scope ?? env().PINTEREST_SCOPES).split(/[ ,]+/).filter(Boolean);
  if (scopes.some((s) => /:write/.test(s))) {
    // Defence in depth: PinInova is read-only. Refuse to store tokens with write scopes.
    throw new ConnectError("exchange_failed", "Unexpected write scope granted; refusing to store this token.");
  }

  // Plan limit (SPEC-001). Reconnecting an account this workspace already has (active or needs_reauth) does not add
  // one — it is already counted — so it is allowed unless the org is over its limit; a new account needs a free slot.
  // Checked after identifying the account; the tokens just obtained are discarded if refused (never stored).
  const [already] = await withWorkspace(workspaceId, (tx) => tx<{ id: string }[]>`
    SELECT id FROM pinterest_connection WHERE workspace_id = ${workspaceId} AND pinterest_user_id = ${pinterestUserId}
    AND status IN ('active', 'needs_reauth')`);
  if (already ? !reconnectWithinLimit(ent) : !ent.canConnect) {
    throw new ConnectError("plan_limit", `Your plan allows ${ent.accountLimit} connected accounts.`);
  }

  return withWorkspace(workspaceId, async (tx) => {
    let consentVersion = CONSENT_TEXT_VERSION;
    if (st.consent_request_id) {
      const [cr] = await tx<{ used_at: Date | null; consent_text_version: string; expires_at: Date }[]>`
        SELECT used_at, consent_text_version, expires_at FROM consent_request WHERE id = ${st.consent_request_id} FOR UPDATE`;
      if (!cr || cr.used_at || cr.expires_at < new Date()) throw new ConnectError("consent_used", "This consent link has already been used or has expired.");
      consentVersion = cr.consent_text_version;
      await tx`UPDATE consent_request SET used_at = now() WHERE id = ${st.consent_request_id}`;
    }

    const [existing] = await tx<{ id: string }[]>`
      SELECT id FROM pinterest_connection WHERE workspace_id = ${workspaceId} AND pinterest_user_id = ${pinterestUserId}
      AND status IN ('active', 'needs_reauth')`;
    const connectionId =
      existing?.id ??
      (
        await tx<{ id: string }[]>`
          INSERT INTO pinterest_connection (workspace_id, mode, pinterest_user_id, username, account_type, scopes)
          VALUES (${workspaceId}, ${env().PINTEREST_MODE}, ${pinterestUserId}, ${account.username ?? pinterestUserId}, ${account.account_type ?? null}, ${scopes})
          RETURNING id`
      )[0]!.id;
    await storeTokens(tx, connectionId, tokens.access_token, tokens.refresh_token ?? null, tokens.expires_in, tokens.refresh_token_expires_in ?? 60 * 86400);
    await tx`UPDATE pinterest_connection SET status = 'active', needs_reauth_since = NULL, scopes = ${scopes} WHERE id = ${connectionId}`;

    const viaClientLink = Boolean(st.consent_request_id);
    const revokeToken = viaClientLink ? newToken() : null;
    await tx`
      INSERT INTO consent_record (workspace_id, connection_id, pinterest_user_id, pinterest_username, scopes, consent_text_version, granted_via, granted_by_user_id, revoke_token_hash)
      VALUES (${workspaceId}, ${connectionId}, ${pinterestUserId}, ${account.username ?? pinterestUserId}, ${scopes}, ${consentVersion},
              ${viaClientLink ? "client_link" : "owner"}, ${st.user_id}, ${revokeToken ? hashToken(revokeToken) : null})`;
    await audit(tx, { orgId, workspaceId, actor: st.user_id ?? `consent_link:${st.consent_request_id}`, action: "connection.connected", target: connectionId, detail: { mode: env().PINTEREST_MODE, scopes, via: viaClientLink ? "client_link" : "owner" } });
    return { workspaceId, connectionId, redirectTo: safeRedirectPath(st.redirect_to), revokeToken, viaClientLink };
  }, orgId).then(async (r) => {
    await enqueue(QUEUES.syncAccount, { connectionId: r.connectionId, workspaceId: r.workspaceId, reason: "initial" }, { singletonKey: r.connectionId }).catch(() => null);
    return r;
  });
}

async function storeTokens(tx: Tx, connectionId: string, access: string, refresh: string | null, expiresIn: number, refreshExpiresIn: number) {
  const k = newDataKey(connectionId, "pinterest");
  await tx`
    UPDATE pinterest_connection SET
      wrapped_key = ${k.wrappedKey}, kek_version = ${k.kekVersion},
      access_token_ct = ${sealSecret(k.dataKey, connectionId, "pinterest", "access", access)},
      refresh_token_ct = ${refresh ? sealSecret(k.dataKey, connectionId, "pinterest", "refresh", refresh) : null},
      access_expires_at = now() + make_interval(secs => ${expiresIn}),
      refresh_expires_at = now() + make_interval(secs => ${refreshExpiresIn}),
      refreshed_at = now()
    WHERE id = ${connectionId}`;
}

interface ConnRow {
  id: string;
  workspace_id: string;
  status: string;
  wrapped_key: Buffer | null;
  kek_version: string | null;
  access_token_ct: Buffer | null;
  refresh_token_ct: Buffer | null;
  access_expires_at: Date | null;
}

function decrypt(c: ConnRow): { access: string; refresh: string | null } {
  if (!c.wrapped_key || !c.kek_version || !c.access_token_ct) throw new PinterestAuthError(401, undefined, "no stored token");
  const dk = unwrapDataKey(c.id, "pinterest", { wrappedKey: c.wrapped_key, kekVersion: c.kek_version });
  return {
    access: openSecret(dk, c.id, "pinterest", "access", c.access_token_ct),
    refresh: c.refresh_token_ct ? openSecret(dk, c.id, "pinterest", "refresh", c.refresh_token_ct) : null,
  };
}

const gatesByConnection = new Map<string, Map<Category, RateGate>>();

/**
 * The only way application code obtains a Pinterest client. Refreshes when the access token
 * expires within a day; marks the connection needs_reauth on an auth failure.
 */
export async function clientFor(workspaceId: string, connectionId: string, opts: { fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void>; baseBackoffMs?: number } = {}): Promise<PinterestClient> {
  const c = await withWorkspace(workspaceId, async (tx) => (await tx<ConnRow[]>`SELECT * FROM pinterest_connection WHERE id = ${connectionId}`)[0]);
  if (!c) throw new Error("connection not found");
  if (c.status !== "active") throw new PinterestAuthError(401, undefined, `connection is ${c.status}`);
  let { access, refresh } = decrypt(c);
  if (c.access_expires_at && c.access_expires_at.getTime() - Date.now() < 86400_000) {
    if (!refresh) {
      await markNeedsReauth(workspaceId, connectionId, "access token expiring and no refresh token");
      throw new PinterestAuthError(401, undefined, "re-authorization required");
    }
    const t = await refreshNow(workspaceId, connectionId, refresh, opts.fetchImpl);
    access = t.access;
  }
  let gates = gatesByConnection.get(connectionId);
  if (!gates) gatesByConnection.set(connectionId, (gates = new Map()));
  return new PinterestClient({ baseUrl: env().PINTEREST_API_BASE, accessToken: access, fetchImpl: opts.fetchImpl, sleep: opts.sleep, baseBackoffMs: opts.baseBackoffMs, gates });
}

export async function refreshNow(workspaceId: string, connectionId: string, refresh?: string, fetchImpl?: typeof fetch) {
  return withWorkspace(workspaceId, async (tx) => {
    // Row lock so two jobs never refresh concurrently (the old refresh token dies on rotation).
    const [c] = await tx<ConnRow[]>`SELECT * FROM pinterest_connection WHERE id = ${connectionId} FOR UPDATE`;
    if (!c) throw new Error("connection not found");
    const current = decrypt(c);
    const rt = current.refresh ?? refresh;
    if (!rt) throw new PinterestAuthError(401, undefined, "no refresh token");
    try {
      const t = await refreshTokens(rt, fetchImpl);
      await storeTokens(tx, connectionId, t.access_token, t.refresh_token ?? rt, t.expires_in, t.refresh_token_expires_in ?? 60 * 86400);
      await audit(tx, { workspaceId, actor: "system", action: "connection.token_refreshed", target: connectionId });
      return { access: t.access_token };
    } catch (e) {
      if (e instanceof PinterestAuthError) {
        await tx`UPDATE pinterest_connection SET status = 'needs_reauth', needs_reauth_since = coalesce(needs_reauth_since, now()), last_sync_error = ${"refresh rejected"} WHERE id = ${connectionId}`;
      }
      throw e;
    }
  });
}

export async function markNeedsReauth(workspaceId: string, connectionId: string, reason: string) {
  await withWorkspace(workspaceId, async (tx) => {
    await tx`UPDATE pinterest_connection SET status = 'needs_reauth', needs_reauth_since = coalesce(needs_reauth_since, now()), last_sync_error = ${reason}
             WHERE id = ${connectionId} AND status = 'active'`;
    await audit(tx, { workspaceId, actor: "system", action: "connection.needs_reauth", target: connectionId, detail: { reason } });
  });
}

/**
 * Disconnect: tokens are destroyed immediately; all data is purged by the purge job
 * (PURGE_DELAY_HOURS, default 0 = as soon as the job runs; Terms allow at most 30 days).
 */
export async function disconnect(p: { workspaceId: string; connectionId: string; actor: string; reason: "user" | "client_revoked" | "agency_removed" | "reauth_expired" | "account_deleted" }) {
  await withWorkspace(p.workspaceId, async (tx) => {
    const res = await tx`
      UPDATE pinterest_connection SET status = 'disconnected', disconnected_at = now(), disconnect_reason = ${p.reason},
        purge_after = now() + make_interval(hours => ${env().PURGE_DELAY_HOURS}),
        access_token_ct = NULL, refresh_token_ct = NULL, wrapped_key = NULL
      WHERE id = ${p.connectionId} AND status IN ('active', 'needs_reauth', 'disconnected')`;
    if (res.count === 0) throw new Error("connection not found");
    await tx`UPDATE consent_record SET revoked_at = coalesce(revoked_at, now()) WHERE connection_id = ${p.connectionId}`;
    await tx`INSERT INTO deletion_log (connection_id, workspace_id, reason, requested_at) VALUES (${p.connectionId}, ${p.workspaceId}, ${p.reason}, now())`;
    await audit(tx, { workspaceId: p.workspaceId, actor: p.actor, action: "connection.disconnected", target: p.connectionId, detail: { reason: p.reason } });
  });
  gatesByConnection.delete(p.connectionId);
  await enqueue(QUEUES.purgeConnection, { connectionId: p.connectionId, workspaceId: p.workspaceId }, { singletonKey: p.connectionId, startAfter: env().PURGE_DELAY_HOURS * 3600 }).catch(() => null);
}

/** Client-side revocation from the link issued after a consent-link connection. */
export async function revokeByToken(token: string) {
  const [r] = await db()<{ workspace_id: string; connection_id: string }[]>`SELECT * FROM system_workspace_of_revoke_token(${hashToken(token)})`;
  if (!r) return false;
  await disconnect({ workspaceId: r.workspace_id, connectionId: r.connection_id, actor: "client:revoke_link", reason: "client_revoked" });
  return true;
}

/** Agency: create a consent link for a client to connect their own account. */
export async function createConsentRequest(p: { workspaceId: string; orgId: string; actor: string; clientEmail?: string | null; days?: number }) {
  const token = newToken();
  await withWorkspace(p.workspaceId, async (tx) => {
    await tx`INSERT INTO consent_request (workspace_id, token_hash, created_by, client_email, consent_text_version, expires_at)
             VALUES (${p.workspaceId}, ${hashToken(token)}, ${p.actor}, ${p.clientEmail ?? null}, ${CONSENT_TEXT_VERSION}, now() + make_interval(days => ${p.days ?? 14}))`;
    await audit(tx, { orgId: p.orgId, workspaceId: p.workspaceId, actor: p.actor, action: "consent.link_created", detail: { client_email: p.clientEmail ?? null } });
  }, p.orgId);
  return { token, url: `${env().APP_URL}/consent/${token}` };
}

export async function lookupConsentRequest(token: string) {
  const [r] = await db()<{ consent_request_id: string; workspace_id: string; workspace_name: string; org_name: string; expires_at: Date; used_at: Date | null; consent_text_version: string }[]>`
    SELECT * FROM system_workspace_of_consent_token(${hashToken(token)})`;
  return r ?? null;
}
