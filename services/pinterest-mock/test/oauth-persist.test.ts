import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createMockServer } from "../src/index.ts";
import { admin, get, login, tokenRequest, TODAY } from "./helpers.ts";

// SPEC-078: with MOCK_STATE_FILE set, issued tokens survive a mock restart, so restarting the local stack does not
// silently log out every connected mock account. Without it the store stays in memory (tests, CI).
const dir = mkdtempSync(join(tmpdir(), "mock-state-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const start = (stateFile?: string) => createMockServer({ port: 0, today: TODAY, seed: 1, stateFile });

describe("OAuth state file", () => {
  it("keeps access and refresh tokens across a restart", async () => {
    const file = join(dir, "a", "oauth.json"); // parent directory is created on first write
    const api1 = await start(file);
    const t = await login(api1, "mock_healthy");
    expect((await get(api1, t.access_token, "/v5/user_account")).status).toBe(200);
    await api1.close();

    const api2 = await start(file);
    try {
      expect((await get(api2, t.access_token, "/v5/user_account")).status).toBe(200);
      const r = await tokenRequest(api2, { grant_type: "refresh_token", refresh_token: t.refresh_token });
      expect(r.status).toBe(200);
    } finally {
      await api2.close();
    }
  });

  it("keeps revocations, and /__mock/reset clears the file's tokens", async () => {
    const file = join(dir, "b.json");
    const api1 = await start(file);
    const t = await login(api1, "mock_viral_fade");
    expect((await admin(api1, "/__mock/revoke", { username: "mock_viral_fade" })).status).toBe(200);
    await api1.close();

    const api2 = await start(file);
    expect((await get(api2, t.access_token, "/v5/user_account")).status).toBe(401);
    const t2 = await login(api2, "mock_healthy");
    await admin(api2, "/__mock/reset");
    await api2.close();

    const api3 = await start(file);
    try {
      expect((await get(api3, t2.access_token, "/v5/user_account")).status).toBe(401);
    } finally {
      await api3.close();
    }
  });

  it("writes nothing when no state file is configured", async () => {
    const api = await start();
    await login(api, "mock_healthy");
    await api.close();
    expect(existsSync(join(dir, "c.json"))).toBe(false);
  });
});
