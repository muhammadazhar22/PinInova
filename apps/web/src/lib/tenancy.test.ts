import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, db, withWorkspace } from "@/lib/db";
import { AccessDenied, createWorkspace, grantClientViewer, listWorkspacesForUser, resolveAccess } from "@/modules/workspaces/access";
import { makeOrgUser, makeUser, owner } from "../../test/factory";

const own = owner();
let a: { userId: string; orgId: string };
let b: { userId: string; orgId: string };
let wsA = "";
let wsB = "";

beforeAll(async () => {
  a = await makeOrgUser(own);
  b = await makeOrgUser(own);
  wsA = await createWorkspace(a.userId, a.orgId, { name: "A client", kind: "client" });
  wsB = await createWorkspace(b.userId, b.orgId, { name: "B own", kind: "own" });
  for (const [ws, n] of [[wsA, 111], [wsB, 222]] as const) {
    await withWorkspace(ws, async (tx) => {
      const [c] = await tx<{ id: string }[]>`INSERT INTO pinterest_connection (workspace_id, mode, pinterest_user_id, username, scopes)
        VALUES (${ws}, 'mock', ${"p" + n}, ${"u" + n}, ${["pins:read"]}) RETURNING id`;
      await tx`INSERT INTO account_metrics_daily (workspace_id, connection_id, date, impressions) VALUES (${ws}, ${c!.id}, current_date - 3, ${n})`;
    });
  }
});
afterAll(async () => {
  await own.end();
  await closeDb();
});

describe("row-level security", () => {
  it("a workspace context only sees its own rows", async () => {
    const rows = await withWorkspace(wsA, (tx) => tx<{ impressions: bigint }[]>`SELECT impressions FROM account_metrics_daily`);
    expect(rows.map((r) => Number(r.impressions))).toEqual([111]);
    const conns = await withWorkspace(wsA, (tx) => tx`SELECT username FROM pinterest_connection`);
    expect(conns.map((r) => r.username)).toEqual(["u111"]);
  });

  it("no context sees nothing, even without a WHERE clause", async () => {
    const rows = await db()`SELECT * FROM account_metrics_daily`;
    expect(rows).toHaveLength(0);
    expect(await db()`SELECT * FROM pinterest_connection`).toHaveLength(0);
  });

  it("cannot write into another tenant", async () => {
    const [cB] = await withWorkspace(wsB, (tx) => tx<{ id: string }[]>`SELECT id FROM pinterest_connection`);
    await expect(
      withWorkspace(wsA, (tx) => tx`INSERT INTO account_metrics_daily (workspace_id, connection_id, date, impressions) VALUES (${wsB}, ${cB!.id}, current_date - 2, 1)`),
    ).rejects.toThrow(/row-level security/);
  });

  it("cannot update or delete another tenant's rows", async () => {
    const res = await withWorkspace(wsA, (tx) => tx`DELETE FROM account_metrics_daily WHERE workspace_id = ${wsB}`);
    expect(res.count).toBe(0);
    const still = await withWorkspace(wsB, (tx) => tx`SELECT 1 FROM account_metrics_daily`);
    expect(still).toHaveLength(1);
  });

  it("partitions cannot be read directly to bypass the parent policy", async () => {
    const part = "account_metrics_daily_" + (await own<{ m: string }[]>`SELECT to_char(current_date - 3, 'YYYYMM') AS m`)[0]!.m;
    const viaOwner = await own.unsafe(`SELECT count(*)::int AS n FROM ${part}`);
    expect(viaOwner[0]!.n).toBeGreaterThanOrEqual(2);
    const direct = await withWorkspace(wsA, (tx) => tx.unsafe(`SELECT * FROM ${part}`));
    expect(direct).toHaveLength(0);
  });

  it("the app role is not the table owner and cannot bypass RLS", async () => {
    const [r] = await db()<{ rolbypassrls: boolean; rolsuper: boolean }[]>`SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname = current_user`;
    expect(r).toEqual({ rolbypassrls: false, rolsuper: false });
  });
});

describe("authorization", () => {
  it("members of another org are denied", async () => {
    await expect(resolveAccess(b.userId, wsA)).rejects.toBeInstanceOf(AccessDenied);
  });
  it("client viewers get read-only access to exactly one workspace", async () => {
    const client = await makeUser(own);
    await grantClientViewer(a.userId, wsA, client);
    const acc = await resolveAccess(client, wsA);
    expect(acc).toMatchObject({ role: "client_viewer", canManage: false });
    await expect(resolveAccess(client, wsB)).rejects.toBeInstanceOf(AccessDenied);
    const list = await listWorkspacesForUser(client);
    expect(list.map((w) => w.id)).toEqual([wsA]);
  });
  it("rejects malformed workspace ids", async () => {
    await expect(resolveAccess(a.userId, "x' OR 1=1")).rejects.toBeInstanceOf(AccessDenied);
  });
});
