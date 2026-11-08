import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import { appPasswordFrom, assertAppRoleIsolated, prepareRoles } from "./db-roles";

const owner = postgres(process.env.DATABASE_OWNER_URL!, { max: 1, onnotice: () => {} });
afterAll(() => owner.end());

describe("database roles (SPEC-073)", () => {
  it("takes the app password from DATABASE_URL only for pinpulse_app", () => {
    expect(appPasswordFrom("postgres://pinpulse_app:s%40cret@db.example/x")).toBe("s@cret");
    expect(appPasswordFrom("postgres://someone:else@db.example/x")).toBeNull();
    expect(appPasswordFrom(undefined)).toBeNull();
  });

  it("the migrated app role cannot bypass RLS", async () => {
    await expect(assertAppRoleIsolated(owner)).resolves.toBeUndefined();
  });

  it("refuses an app role that bypasses RLS (e.g. created in the Neon console)", async () => {
    await owner.unsafe("DROP ROLE IF EXISTS pinpulse_bypass_probe");
    await owner.unsafe("CREATE ROLE pinpulse_bypass_probe NOLOGIN BYPASSRLS");
    try {
      await expect(assertAppRoleIsolated(owner, "pinpulse_bypass_probe")).rejects.toThrow(/bypass row-level security/);
    } finally {
      await owner.unsafe("DROP ROLE pinpulse_bypass_probe");
    }
  });

  it("refuses the default app password in production", async () => {
    await expect(prepareRoles(owner, { appPassword: "pinpulse_app", production: true })).rejects.toThrow(/default password/);
    await expect(prepareRoles(owner, { appPassword: null, production: true })).rejects.toThrow(/default password/);
  });
});
