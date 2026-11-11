import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, withWorkspace } from "@/lib/db";
import { stopBoss } from "@/modules/jobs/boss";
import { createWorkspace } from "@/modules/workspaces/access";
import { completeConnect, connectAllowed, markNeedsReauth, startConnect } from "./connections";
import { makeOrgUser, owner } from "../../../test/factory";

const own = owner();
let ws = "";
let orgId = "";
let userId = "";
let pinterestUser = "";

/** Fake Pinterest: token exchange + user_account for whoever `pinterestUser` currently is. */
const fakePinterest = (async (input: RequestInfo | URL) => {
  const url = String(input);
  const body = url.endsWith("/oauth/token")
    ? { access_token: `at-${pinterestUser}`, refresh_token: `rt-${pinterestUser}`, expires_in: 2592000, refresh_token_expires_in: 31536000, scope: "user_accounts:read,pins:read,boards:read", token_type: "bearer" }
    : { id: pinterestUser, username: pinterestUser, account_type: "BUSINESS" };
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}) as typeof fetch;

async function connect(asPinterestUser: string) {
  pinterestUser = asPinterestUser;
  const { url, nonce } = await startConnect({ workspaceId: ws, userId, redirectTo: "/x" });
  const state = new URL(url).searchParams.get("state")!;
  return completeConnect({ state, nonce, sessionUserId: userId, code: "code", fetchImpl: fakePinterest });
}

beforeAll(async () => {
  ({ orgId, userId } = await makeOrgUser(own));
  ws = await createWorkspace(userId, orgId, { name: "Reconnect at limit", kind: "own" });
  // Solo plan: exactly one connected account.
  await own`INSERT INTO subscription (org_id, plan, status) VALUES (${orgId}, 'solo', 'active') ON CONFLICT (org_id) DO UPDATE SET plan = 'solo', status = 'active'`;
});
afterAll(async () => {
  await stopBoss();
  await closeDb();
  await own.end();
});

describe("reconnecting at the plan's account limit (SPEC-001)", () => {
  it("lets the same Pinterest account reconnect, and still refuses a new one", async () => {
    const first = await connect("pu_owner");
    await markNeedsReauth(ws, first.connectionId, "token rejected");

    // The Connect/Reconnect button: a new account is over the limit, reconnecting the flagged one is not.
    expect((await connectAllowed(orgId, ws)).ok).toBe(false);
    expect((await connectAllowed(orgId, ws, first.connectionId)).ok).toBe(true);

    const again = await connect("pu_owner");
    expect(again.connectionId).toBe(first.connectionId);
    const [c] = await withWorkspace(ws, (tx) => tx<{ status: string }[]>`SELECT status FROM pinterest_connection WHERE id = ${first.connectionId}`);
    expect(c!.status).toBe("active");

    await expect(connect("pu_someone_else")).rejects.toMatchObject({ reason: "plan_limit" });
  });

  it("does not treat an active connection as a reconnect", async () => {
    const [c] = await withWorkspace(ws, (tx) => tx<{ id: string }[]>`SELECT id FROM pinterest_connection WHERE status = 'active' LIMIT 1`);
    expect((await connectAllowed(orgId, ws, c!.id)).ok).toBe(false);
  });
});
