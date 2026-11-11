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

describe("issue ownership", () => {
  it("link checks leave the analysis-owned domain:traffic_drop issue alone (open stays open, validating is not 'passed')", async () => {
    const a = await makeOrgUser(own);
    const w = await createWorkspace(a.userId, a.orgId, { name: "Ownership", kind: "own" });
    const c = await withWorkspace(w, async (tx) => {
      const [row] = await tx<{ id: string }[]>`INSERT INTO pinterest_connection (workspace_id, mode, pinterest_user_id, username, scopes)
        VALUES (${w}, 'mock', 'pu_own', 'owner_test', ${["pins:read"]}) RETURNING id`;
      await tx`INSERT INTO issue (workspace_id, connection_id, kind, source, severity, title, detail) VALUES
        (${w}, ${row!.id}, 'domain:traffic_drop', 'unknown', 'warning', 'Pins linking to deal-hub lost 95%', '{}'),
        (${w}, ${row!.id}, 'domain:crawl_delay', 'you', 'warning', 'Crawl-delay above 1 second', '{}')`;
      await tx`UPDATE issue SET state = 'validating' WHERE connection_id = ${row!.id} AND kind = 'domain:traffic_drop'`;
      return row!.id;
    });
    const unused = (async () => { throw new Error("no API call expected"); }) as typeof fetch;
    await runIntegrityChecks(w, c, { client: new PinterestClient({ baseUrl: "http://pinterest.test/v5", accessToken: "t", fetchImpl: unused }), pins: [] });
    const rows = await withWorkspace(w, (tx) => tx<{ kind: string; state: string }[]>`SELECT kind, state FROM issue WHERE connection_id = ${c} ORDER BY kind`);
    // crawl_delay is the link checks' own issue and no longer found: resolved. traffic_drop belongs to analysis: untouched.
    expect(rows).toEqual([{ kind: "domain:crawl_delay", state: "resolved" }, { kind: "domain:traffic_drop", state: "validating" }]);
  });
});
