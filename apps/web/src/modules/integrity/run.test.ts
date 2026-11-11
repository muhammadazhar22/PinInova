import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, withWorkspace } from "@/lib/db";
import { stopBoss } from "@/modules/jobs/boss";
import { PinterestClient } from "@/modules/pinterest/client";
import { PinterestAuthError } from "@/modules/pinterest/errors";
import { createWorkspace } from "@/modules/workspaces/access";
import { runIntegrityChecks } from "./run";
import { makeOrgUser, owner } from "../../../test/factory";

const own = owner();
let ws = "";
let conn = "";

beforeAll(async () => {
  const a = await makeOrgUser(own);
  ws = await createWorkspace(a.userId, a.orgId, { name: "Integrity 401", kind: "own" });
  conn = await withWorkspace(ws, async (tx) => {
    const [c] = await tx<{ id: string }[]>`INSERT INTO pinterest_connection (workspace_id, mode, pinterest_user_id, username, scopes)
      VALUES (${ws}, 'mock', 'pu401', 'revoked_user', ${["pins:read"]}) RETURNING id`;
    return c!.id;
  });
});
afterAll(async () => {
  await stopBoss();
  await closeDb();
  await own.end();
});

describe("integrity checks", () => {
  it("flags the connection for re-authorization when Pinterest answers 401 (CLAUDE.md: 401 → re-auth)", async () => {
    const unauthorized = (async () =>
      new Response(JSON.stringify({ code: 2, message: "Authentication failed." }), { status: 401, headers: { "content-type": "application/json" } })) as typeof fetch;
    const client = new PinterestClient({ baseUrl: "http://pinterest.test/v5", accessToken: "expired", fetchImpl: unauthorized });
    await expect(runIntegrityChecks(ws, conn, { client })).rejects.toBeInstanceOf(PinterestAuthError);
    const [c] = await withWorkspace(ws, (tx) => tx<{ status: string; last_sync_error: string | null }[]>`SELECT status, last_sync_error FROM pinterest_connection WHERE id = ${conn}`);
    expect(c!.status).toBe("needs_reauth");
  });
});
