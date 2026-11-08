import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { REDIRECT, SCOPES, admin, authorizeCode, basic, get, login, startEnv, tokenRequest, validateComponent, type Env } from "./helpers.ts";

let env: Env;
let clock = Date.parse("2026-11-08T12:00:00Z");
beforeAll(async () => {
  env = await startEnv({ now: () => clock });
});
afterAll(() => env.close());

describe("OAuth authorize + consent", () => {
  it("renders a clearly labelled MOCK consent page with accounts and scopes", async () => {
    const u = new URL(`${env.api.url}/oauth/`);
    u.search = new URLSearchParams({ client_id: "mock-client-id", redirect_uri: REDIRECT, response_type: "code", scope: SCOPES, state: "abc" }).toString();
    const r = await fetch(u);
    expect(r.status).toBe(200);
    const html = await r.text();
    expect(html).toContain("<title>MOCK Pinterest — not the real Pinterest</title>");
    for (const u of ["mock_healthy", "mock_platform_cliff", "mock_domain_block", "mock_new_pins_zero", "mock_quality_drop", "mock_viral_fade", "mock_agency_client_1", "mock_agency_client_2"]) {
      expect(html).toContain(`value="${u}"`);
    }
    for (const s of SCOPES.split(",")) expect(html).toContain(s);
    expect(html).toContain('action="/oauth/consent"');
    expect(html).toMatch(/value="allow"/);
    expect(html).toMatch(/value="deny"/);
  });

  it("Allow redirects with code+state; Deny redirects with error=access_denied", async () => {
    const post = (decision: string) =>
      fetch(`${env.api.url}/oauth/consent`, {
        method: "POST",
        redirect: "manual",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: "mock-client-id", redirect_uri: REDIRECT, scope: SCOPES, state: "s1", username: "mock_viral_fade", decision }).toString(),
      });
    const allow = await post("allow");
    expect(allow.status).toBe(302);
    const loc = new URL(allow.headers.get("location")!);
    expect(`${loc.origin}${loc.pathname}`).toBe(REDIRECT);
    expect(loc.searchParams.get("code")).toMatch(/^mockcode_/);
    expect(loc.searchParams.get("state")).toBe("s1");
    const tok = await tokenRequest(env.api, { grant_type: "authorization_code", code: loc.searchParams.get("code")!, redirect_uri: REDIRECT });
    expect(tok.status).toBe(200);
    const me = await get(env.api, tok.body.access_token as string, "/v5/user_account");
    expect(me.body.username).toBe("mock_viral_fade");

    const deny = await post("deny");
    const dloc = new URL(deny.headers.get("location")!);
    expect(dloc.searchParams.get("error")).toBe("access_denied");
    expect(dloc.searchParams.get("state")).toBe("s1");
    expect(dloc.searchParams.get("code")).toBeNull();
  });

  it("validates client_id and response_type", async () => {
    const bad = await fetch(`${env.api.url}/oauth/?client_id=nope&redirect_uri=${encodeURIComponent(REDIRECT)}&response_type=code&scope=pins:read`, { redirect: "manual" });
    expect(bad.status).toBe(400);
    expect(await bad.text()).toContain("MOCK Pinterest");
    const rt = await fetch(`${env.api.url}/oauth/?client_id=mock-client-id&redirect_uri=${encodeURIComponent(REDIRECT)}&response_type=token&state=x`, { redirect: "manual" });
    expect(rt.status).toBe(302);
    expect(new URL(rt.headers.get("location")!).searchParams.get("error")).toBe("unsupported_response_type");
    const noRedirect = await fetch(`${env.api.url}/oauth/?client_id=mock-client-id&response_type=code`, { redirect: "manual" });
    expect(noRedirect.status).toBe(400);
  });

  it("mock_user skips the consent page; auto consent defaults to mock_healthy", async () => {
    const code = await authorizeCode(env.api, "mock_domain_block");
    expect(code).toMatch(/^mockcode_/);
    const unknown = await fetch(`${env.api.url}/oauth/?client_id=mock-client-id&redirect_uri=${encodeURIComponent(REDIRECT)}&response_type=code&mock_user=nobody`, { redirect: "manual" });
    expect(unknown.status).toBe(400);

    const auto = await startEnv({ autoConsent: true });
    try {
      const r = await fetch(`${auto.api.url}/oauth/?client_id=mock-client-id&redirect_uri=${encodeURIComponent(REDIRECT)}&response_type=code&scope=${SCOPES}&state=q`, { redirect: "manual" });
      expect(r.status).toBe(302);
      const code2 = new URL(r.headers.get("location")!).searchParams.get("code")!;
      const t = await tokenRequest(auto.api, { grant_type: "authorization_code", code: code2, redirect_uri: REDIRECT });
      const me = await get(auto.api, t.body.access_token as string, "/v5/user_account");
      expect(me.body.username).toBe("mock_healthy");
    } finally {
      await auto.close();
    }
  });
});

describe("OAuth token endpoint", () => {
  it("happy path: token response matches the spec's OauthAccessToken schema", async () => {
    const code = await authorizeCode(env.api, "mock_healthy");
    const t = await tokenRequest(env.api, { grant_type: "authorization_code", code, redirect_uri: REDIRECT });
    expect(t.status).toBe(200);
    expect(validateComponent("OauthAccessToken", t.body)).toEqual([]);
    expect(t.body).toMatchObject({ token_type: "bearer", response_type: "authorization_code", expires_in: 2592000, refresh_token_expires_in: 5184000, scope: SCOPES });
    expect(String(t.body.access_token)).toMatch(/^pina_MOCK_/);
    expect(String(t.body.refresh_token)).toMatch(/^pinr_MOCK_/);
    expect(t.headers.get("x-ratelimit-limit")).toBeTruthy();
  });

  it("rejects an invalid client (bad secret or missing Basic auth) with 401 + error shape", async () => {
    const code = await authorizeCode(env.api, "mock_healthy");
    const bad = await tokenRequest(env.api, { grant_type: "authorization_code", code, redirect_uri: REDIRECT }, basic("mock-client-id", "wrong"));
    expect(bad.status).toBe(401);
    expect(validateComponent("Pinterest.Lib.Error", bad.body)).toEqual([]);
    const none = await tokenRequest(env.api, { grant_type: "authorization_code", code, redirect_uri: REDIRECT }, "");
    expect(none.status).toBe(401);
    // the code was not consumed by the failed attempts
    const ok = await tokenRequest(env.api, { grant_type: "authorization_code", code, redirect_uri: REDIRECT });
    expect(ok.status).toBe(200);
  });

  it("codes are single-use, bound to redirect_uri, and expire after 10 minutes", async () => {
    const code = await authorizeCode(env.api, "mock_healthy");
    const mismatch = await tokenRequest(env.api, { grant_type: "authorization_code", code, redirect_uri: "http://127.0.0.1:3999/other" });
    expect(mismatch.status).toBe(400);
    const first = await tokenRequest(env.api, { grant_type: "authorization_code", code, redirect_uri: REDIRECT });
    expect(first.status).toBe(200);
    const reuse = await tokenRequest(env.api, { grant_type: "authorization_code", code, redirect_uri: REDIRECT });
    expect(reuse.status).toBe(400);
    expect(reuse.body).toMatchObject({ code: 1 });
    expect(String(reuse.body.message)).toMatch(/already been used/);

    const code2 = await authorizeCode(env.api, "mock_healthy");
    clock += 10 * 60 * 1000 + 1000;
    const expired = await tokenRequest(env.api, { grant_type: "authorization_code", code: code2, redirect_uri: REDIRECT });
    expect(expired.status).toBe(400);
    expect(String(expired.body.message)).toMatch(/expired/);
  });

  it("refresh rotates the refresh token and invalidates the old one", async () => {
    const t1 = await login(env.api, "mock_quality_drop");
    const r1 = await tokenRequest(env.api, { grant_type: "refresh_token", refresh_token: t1.refresh_token });
    expect(r1.status).toBe(200);
    expect(validateComponent("OauthAccessToken", r1.body)).toEqual([]);
    expect(r1.body.response_type).toBe("refresh_token");
    expect(r1.body.refresh_token).not.toBe(t1.refresh_token);
    expect(r1.body.access_token).not.toBe(t1.access_token);
    const me = await get(env.api, r1.body.access_token as string, "/v5/user_account");
    expect(me.body.username).toBe("mock_quality_drop");
    // old refresh token is dead
    const again = await tokenRequest(env.api, { grant_type: "refresh_token", refresh_token: t1.refresh_token });
    expect(again.status).toBe(400);
    expect(validateComponent("Pinterest.Lib.Error", again.body)).toEqual([]);
    // the rotated one works (continuous refresh)
    const r2 = await tokenRequest(env.api, { grant_type: "refresh_token", refresh_token: r1.body.refresh_token as string });
    expect(r2.status).toBe(200);
  });

  it("access tokens expire after 30 days; refresh tokens after 60 days without use", async () => {
    const t = await login(env.api, "mock_healthy");
    clock += 30 * 86_400_000 + 1000;
    const r = await get(env.api, t.access_token, "/v5/user_account");
    expect(r.status).toBe(401);
    const ref = await tokenRequest(env.api, { grant_type: "refresh_token", refresh_token: t.refresh_token });
    expect(ref.status).toBe(200);
    clock += 61 * 86_400_000;
    const late = await tokenRequest(env.api, { grant_type: "refresh_token", refresh_token: ref.body.refresh_token as string });
    expect(late.status).toBe(400);
  });

  it("rejects unknown grant types and non-form bodies", async () => {
    expect((await tokenRequest(env.api, { grant_type: "password" })).status).toBe(400);
    const r = await fetch(`${env.api.url}/v5/oauth/token`, { method: "POST", headers: { authorization: basic(), "content-type": "application/json" }, body: "{}" });
    expect(r.status).toBe(400);
  });
});

describe("token invalidation", () => {
  it("401 with Pinterest error shape for unknown, expired (admin) and revoked tokens", async () => {
    const unknown = await get(env.api, "pina_nope", "/v5/user_account");
    expect(unknown.status).toBe(401);
    expect(validateComponent("Pinterest.Lib.Error", unknown.body)).toEqual([]);
    expect(unknown.body.code).toBe(2);
    expect((await get(env.api, null, "/v5/user_account")).status).toBe(401);

    const a = await login(env.api, "mock_platform_cliff");
    expect((await admin(env.api, "/__mock/expire-access-token", { access_token: a.access_token })).status).toBe(200);
    const exp = await get(env.api, a.access_token, "/v5/user_account");
    expect(exp.status).toBe(401);
    expect(exp.body.message).toMatch(/expired/);

    const b = await login(env.api, "mock_new_pins_zero");
    const c = await login(env.api, "mock_new_pins_zero");
    const other = await login(env.api, "mock_healthy");
    const rev = await admin(env.api, "/__mock/revoke", { username: "mock_new_pins_zero" });
    expect(rev.status).toBe(200);
    expect(rev.body.revoked.access).toBeGreaterThanOrEqual(2);
    for (const t of [b, c]) {
      const r = await get(env.api, t.access_token, "/v5/pins");
      expect(r.status).toBe(401);
      expect(r.body.message).toMatch(/revoked/);
      expect((await tokenRequest(env.api, { grant_type: "refresh_token", refresh_token: t.refresh_token })).status).toBe(400);
    }
    expect((await get(env.api, other.access_token, "/v5/user_account")).status).toBe(200);
    // the user can reconnect after removing the app
    const again = await login(env.api, "mock_new_pins_zero");
    expect((await get(env.api, again.access_token, "/v5/user_account")).status).toBe(200);
  });

  it("enforces scopes", async () => {
    const t = await login(env.api, "mock_healthy", "user_accounts:read");
    expect((await get(env.api, t.access_token, "/v5/user_account")).status).toBe(200);
    const pins = await get(env.api, t.access_token, "/v5/pins");
    expect(pins.status).toBe(403);
    expect(pins.body.code).toBe(3);
  });

  it("admin state and reset", async () => {
    const st = await admin(env.api, "/__mock/state");
    expect(st.body.mock).toBe(true);
    expect(st.body.oauth.access_tokens.length).toBeGreaterThan(0);
    await admin(env.api, "/__mock/reset");
    const st2 = await admin(env.api, "/__mock/state");
    expect(st2.body.oauth.access_tokens.length).toBe(0);
    const accts = (await fetch(`${env.api.url}/__mock/accounts`).then((r) => r.json())) as { accounts: unknown[] };
    expect(accts.accounts).toHaveLength(8);
  });
});
