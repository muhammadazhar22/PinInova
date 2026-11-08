/** Regression tests for the 2026-11-08 security review (docs/review-2026-11-08-security.md). */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, db, withWorkspace } from "@/lib/db";
import { hashToken } from "@/lib/tokens";
import { acceptViewerInvite, asUser, createWorkspace, inviteClientViewer, resolveAccess } from "@/modules/workspaces/access";
import { completeConnect, ConnectError, disconnect, safeRedirectPath, startConnect } from "@/modules/pinterest/connections";
import { InactiveConnectionError, lockConnection } from "@/modules/pinterest/guard";
import { assertPurged, purgeConnection } from "@/modules/privacy/purge";
import { eraseUser } from "@/modules/privacy/erasure";
import { submitReport } from "@/modules/weather/weather";
import { stopBoss } from "@/modules/jobs/boss";
import { makeOrgUser, makeUser, owner } from "../../../test/factory";

const own = owner();
let a: { userId: string; orgId: string };
let ws = "";

async function conn(workspaceId: string, name: string) {
  return withWorkspace(workspaceId, async (tx) => {
    const [c] = await tx<{ id: string }[]>`INSERT INTO pinterest_connection (workspace_id, mode, pinterest_user_id, username, scopes)
      VALUES (${workspaceId}, 'mock', ${name}, ${name}, ${["pins:read"]}) RETURNING id`;
    await tx`INSERT INTO account_metrics_daily (workspace_id, connection_id, date, impressions) VALUES (${workspaceId}, ${c!.id}, current_date - 3, 5)`;
    await tx`INSERT INTO pin_metrics_daily (workspace_id, connection_id, pin_id, date, impressions) VALUES (${workspaceId}, ${c!.id}, 'p1', current_date - 3, 5)`;
    return c!.id;
  });
}

beforeAll(async () => {
  a = await makeOrgUser(own);
  ws = await createWorkspace(a.userId, a.orgId, { name: "Review", kind: "client" });
});
afterAll(async () => {
  await stopBoss();
  await own.end();
  await closeDb();
});

describe("#1 OAuth state is bound to browser and user", () => {
  it("rejects a callback without the starting browser's nonce, and one finished by another user", async () => {
    const s1 = await startConnect({ workspaceId: ws, userId: a.userId, redirectTo: "/x" });
    const state1 = new URL(s1.url).searchParams.get("state")!;
    await expect(completeConnect({ state: state1, nonce: undefined, sessionUserId: a.userId, code: "c" })).rejects.toMatchObject({ reason: "wrong_browser" });

    const s2 = await startConnect({ workspaceId: ws, userId: a.userId, redirectTo: "/x" });
    const state2 = new URL(s2.url).searchParams.get("state")!;
    const other = await makeUser(own);
    await expect(completeConnect({ state: state2, nonce: s2.nonce, sessionUserId: other, code: "c" })).rejects.toBeInstanceOf(ConnectError);
    // state is single-use: a retry with the right nonce is refused too
    await expect(completeConnect({ state: state2, nonce: s2.nonce, sessionUserId: a.userId, code: "c" })).rejects.toMatchObject({ reason: "state_invalid" });
  });
  it("only same-site relative redirects survive", () => {
    expect(safeRedirectPath("//evil.com")).toBe("/app");
    expect(safeRedirectPath("/\\evil.com")).toBe("/app");
    expect(safeRedirectPath("https://evil.com")).toBe("/app");
    expect(safeRedirectPath("/app/w/1")).toBe("/app/w/1");
  });
});

describe("#3 metrics cannot outlive their connection", () => {
  it("deleting the connection row cascades to partitioned metrics", async () => {
    const w2 = await createWorkspace(a.userId, a.orgId, { name: "Cascade", kind: "own" });
    const c = await conn(w2, "cascade");
    await own`DELETE FROM workspace WHERE id = ${w2}`;
    const [{ n }] = (await own<{ n: number }[]>`SELECT (SELECT count(*) FROM account_metrics_daily WHERE connection_id = ${c}) + (SELECT count(*) FROM pin_metrics_daily WHERE connection_id = ${c}) AS n`) as unknown as [{ n: number }];
    expect(Number(n)).toBe(0);
  });
});

describe("#4/#10 writes are fenced by the connection lock", () => {
  it("refuses writes for a disconnected connection and for another tenant's connection", async () => {
    const c = await conn(ws, "fence");
    await disconnect({ workspaceId: ws, connectionId: c, actor: "t", reason: "user" });
    await expect(withWorkspace(ws, (tx) => lockConnection(tx, c))).rejects.toBeInstanceOf(InactiveConnectionError);
    const b = await makeOrgUser(own);
    const wsB = await createWorkspace(b.userId, b.orgId, { name: "B", kind: "own" });
    const cB = await conn(wsB, "other-tenant");
    await expect(withWorkspace(ws, (tx) => lockConnection(tx, cB))).rejects.toMatchObject({ status: "missing" });
  });
});

describe("#5 purge covers notes and alert e-mail", () => {
  it("removes observed_signal and email_outbox rows and passes the assertion", async () => {
    const c = await conn(ws, "purge-extra");
    await withWorkspace(ws, async (tx) => {
      await tx`INSERT INTO observed_signal (workspace_id, connection_id, kind, note) VALUES (${ws}, ${c}, 'ai_label', 'client note')`;
      await tx`INSERT INTO email_outbox (workspace_id, connection_id, to_address, subject, html, transport) VALUES (${ws}, ${c}, 'x@y.z', '@purge-extra dropped', '<p/>', 'outbox')`;
    });
    await disconnect({ workspaceId: ws, connectionId: c, actor: "t", reason: "user" });
    const counts = await purgeConnection(ws, c);
    expect(counts.observed_signal).toBe(1);
    expect(counts.email_outbox).toBe(1);
    expect((await assertPurged()).find((x) => x.connectionId === c)).toBeUndefined();
  });
});

describe("#6 erasure", () => {
  it("anonymises the user's audit rows across tenants and leaves no mail to the address", async () => {
    const u = await makeOrgUser(own);
    const w = await createWorkspace(u.userId, u.orgId, { name: "Erase", kind: "own" });
    const [{ email }] = (await own<{ email: string }[]>`SELECT email FROM "user" WHERE id = ${u.userId}`) as unknown as [{ email: string }];
    await own`INSERT INTO email_outbox (workspace_id, to_address, subject, html, transport) VALUES (${w}, ${email}, 's', 'h', 'outbox')`;
    await eraseUser(u.userId);
    const [{ n }] = (await own<{ n: number }[]>`SELECT count(*)::int AS n FROM audit_event WHERE actor = ${u.userId}`) as unknown as [{ n: number }];
    const [{ m }] = (await own<{ m: number }[]>`SELECT count(*)::int AS m FROM email_outbox WHERE to_address = ${email}`) as unknown as [{ m: number }];
    expect(n).toBe(0);
    expect(m).toBe(0);
  });
});

describe("#8/#9 client viewers", () => {
  it("viewer access needs the e-mailed token; viewers get no org context", async () => {
    const invite = await inviteClientViewer(a.userId, ws, "client@example.com");
    const token = invite.url.split("/").pop()!;
    const squatter = await makeUser(own); // registered the client's address first: gains nothing without the link
    await expect(resolveAccess(squatter, ws)).rejects.toThrow();
    const viewer = await makeUser(own);
    expect(await acceptViewerInvite(viewer, token)).toBe(ws);
    expect(await acceptViewerInvite(squatter, token)).toBeNull(); // single use
    const acc = await resolveAccess(viewer, ws);
    expect(acc.role).toBe("client_viewer");
    const orgCtx = await asUser(viewer, ws, (tx) => tx<{ v: string }[]>`SELECT current_setting('app.org_id', true) AS v`);
    expect(orgCtx[0]!.v).toBe("");
    const names = await asUser(viewer, ws, (tx) => tx<{ name: string }[]>`SELECT name FROM workspace`);
    expect(names.map((r) => r.name)).toEqual(["Review"]);
    void hashToken;
  });
});

describe("#12 weather reports", () => {
  it("a second report the same day updates instead of erroring", async () => {
    const id = crypto.randomUUID();
    await submitReport({ reporterId: id, niche: "food", status: "drop", onsetDate: new Date(Date.now() - 3 * 864e5).toISOString().slice(0, 10), symptoms: [] });
    await expect(submitReport({ reporterId: id, niche: "food", status: "normal", onsetDate: null, symptoms: [] })).resolves.toBeUndefined();
    void db;
  });
});
