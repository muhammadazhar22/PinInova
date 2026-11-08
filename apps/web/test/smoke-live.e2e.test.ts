import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb } from "@/lib/db";
import { completeConnect, startConnect } from "@/modules/pinterest/connections";
import { runSmoke } from "@/modules/pinterest/smoke";
import { createWorkspace } from "@/modules/workspaces/access";
import { makeOrgUser, owner } from "./factory";

// SPEC-076: the smoke test runs end to end against MOCK Pinterest (the mock's guesses must pass their own checks).
const own = owner();
let ws = "";
let connectionId = "";

beforeAll(async () => {
  const { orgId, userId } = await makeOrgUser(own);
  ws = await createWorkspace(userId, orgId, { name: "smoke", kind: "client" });
  const { url, nonce } = await startConnect({ workspaceId: ws, userId, redirectTo: "/done" });
  const u = new URL(url);
  u.searchParams.set("mock_user", "mock_domain_block");
  const back = new URL((await fetch(u, { redirect: "manual" })).headers.get("location")!);
  ({ connectionId } = await completeConnect({ state: back.searchParams.get("state")!, nonce, sessionUserId: userId, code: back.searchParams.get("code") }));
});
afterAll(async () => {
  await own.end();
  await closeDb();
});

describe("smoke-live against the mock", () => {
  it("passes every contract check and labels the run as mock", async () => {
    const r = await runSmoke({ workspaceId: ws, connectionId });
    expect(r.mode).toBe("mock");
    const by = Object.fromEntries(r.results.map((x) => [x.id, x]));
    expect(r.ok, JSON.stringify(r.results, null, 2)).toBe(true);
    for (const id of ["user_account", "analytics_split_keys", "pa08_provisional_days", "timestamps", "user_account_websites", "robots_txt"]) {
      expect(by[id]?.status, `${id}: ${by[id]?.detail}`).toBe("pass");
    }
    expect(by.analytics_csv_export?.status).toBe("skip");
    expect(r.apiCalls).toBeLessThanOrEqual(6);
  });
});
