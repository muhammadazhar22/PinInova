import { describe, expect, it } from "vitest";
import { createMockServer, createMockSites } from "../src/index.ts";

// A wildcard bind address ("::" = IPv4+IPv6, "0.0.0.0") is not something a client can connect to. The URL the
// mock advertises (image URLs, authorize hint, `url`) must be loopback, or the web app's image fetch — which only
// allows the PINTEREST_API_BASE host — rejects every Pin image and duplicate detection finds nothing (SPEC-078).
describe.each(["::", "0.0.0.0"])("listening on %s", (host) => {
  it("advertises a connectable loopback URL for the API and its image links", async () => {
    const api = await createMockServer({ host, port: 0, today: "2026-11-08", seed: 1 });
    try {
      expect(api.url).toBe(`http://127.0.0.1:${api.port}`);
      const accounts = (await (await fetch(`${api.url}/__mock/accounts`)).json()) as { accounts: { authorize_url_hint: string }[] };
      expect(accounts.accounts[0]!.authorize_url_hint.startsWith(`${api.url}/oauth/`)).toBe(true);
      const img = await fetch(`${api.url}/__img/account-1.png`);
      expect(img.status).toBeLessThan(500);
    } finally {
      await api.close();
    }
  });

  it("advertises a connectable loopback URL for the mock websites", async () => {
    const sites = await createMockSites({ host, port: 0 });
    try {
      expect(sites.url).toBe(`http://127.0.0.1:${sites.port}`);
      expect((await fetch(`${sites.url}/`)).status).toBeLessThan(500);
    } finally {
      await sites.close();
    }
  });
});
