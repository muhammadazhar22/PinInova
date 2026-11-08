import { describe, expect, it } from "vitest";
import { scrubEvent, scrubUrl } from "./scrub";

describe("Sentry scrubbing (SPEC-072)", () => {
  it("redacts capability tokens in URL paths and drops query strings", () => {
    expect(scrubUrl("https://staging.example.com/consent/abcDEF123456789xyz?x=1")).toBe("https://staging.example.com/consent/[token]");
    expect(scrubUrl("/r/abcdefghijklmnop")).toBe("/r/[token]");
    expect(scrubUrl("/invite/abcdefghijklmnop/accept")).toBe("/invite/[token]/accept");
    expect(scrubUrl("/revoke/abcdefghijklmnop")).toBe("/revoke/[token]");
    expect(scrubUrl("/api/consent/abcdefghijklmnop/start")).toBe("/api/consent/[token]/start");
    expect(scrubUrl("/api/pinterest/callback?code=secret&state=s")).toBe("/api/pinterest/callback");
    expect(scrubUrl("/app/w/123")).toBe("/app/w/123");
  });

  it("removes cookies, headers, bodies, user identity and IPs", () => {
    const e = scrubEvent({
      request: {
        url: "https://x.test/consent/abcdefghijklmnopq?y=1",
        query_string: "code=abc",
        cookies: { "better-auth.session_token": "s" },
        headers: { cookie: "a=b", authorization: "Bearer abcdefghijkl", "user-agent": "UA" },
        data: { password: "p" },
      },
      user: { id: "u1", email: "a@b.c", ip_address: "1.2.3.4" },
      message: "failed with access_token=abcdefghijklmnop",
    });
    expect(e.request).toEqual({ url: "https://x.test/consent/[token]", headers: { "user-agent": "UA" } });
    expect(e.user).toEqual({ id: "u1" });
    expect(e.message).toBe("failed with access_token=[redacted]");
  });

  it("redacts secrets inside exception messages and breadcrumbs", () => {
    const e = scrubEvent({
      exception: { values: [{ type: "Error", value: "pinterest 401 Bearer abcdefghijklmnop" }] },
      breadcrumbs: [{ category: "fetch", message: "x", data: { url: "https://api.pinterest.com/v5/oauth/token?code=zzz" } }],
    });
    expect(e.exception?.values?.[0]?.value).toBe("pinterest 401 Bearer [redacted]");
    expect(e.breadcrumbs?.[0]?.data?.url).toBe("https://api.pinterest.com/v5/oauth/token");
  });

  it("drops extra/contexts that could carry Pinterest data", () => {
    const e = scrubEvent({ extra: { metrics: [1, 2] }, contexts: { trace: { trace_id: "t" }, state: { x: 1 } } });
    expect(e.extra).toBeUndefined();
    expect(e.contexts).toEqual({ trace: { trace_id: "t" } });
  });
});
