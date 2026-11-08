import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, db, withWorkspace } from "@/lib/db";
import { createWorkspace } from "@/modules/workspaces/access";
import { stopBoss } from "@/modules/jobs/boss";
import { disconnect } from "@/modules/pinterest/connections";
import { newDataKey, sealSecret } from "@/lib/crypto/vault";
import { assertPurged, purgeConnection, runRetention } from "./purge";
import { makeOrgUser, owner } from "../../../test/factory";

const own = owner();
let ws = "";
let conn = "";

beforeAll(async () => {
  const a = await makeOrgUser(own);
  ws = await createWorkspace(a.userId, a.orgId, { name: "Purge test", kind: "own" });
  conn = await withWorkspace(ws, async (tx) => {
    const [c] = await tx<{ id: string }[]>`INSERT INTO pinterest_connection (workspace_id, mode, pinterest_user_id, username, scopes)
      VALUES (${ws}, 'mock', 'pu1', 'someone', ${["pins:read"]}) RETURNING id`;
    const k = newDataKey(c!.id, "pinterest");
    await tx`UPDATE pinterest_connection SET wrapped_key = ${k.wrappedKey}, kek_version = ${k.kekVersion},
      access_token_ct = ${sealSecret(k.dataKey, c!.id, "pinterest", "access", "tok")} WHERE id = ${c!.id}`;
    await tx`INSERT INTO consent_record (workspace_id, connection_id, pinterest_user_id, pinterest_username, scopes, consent_text_version, granted_via)
      VALUES (${ws}, ${c!.id}, 'pu1', 'someone', ${["pins:read"]}, 'v', 'owner')`;
    for (let d = 1; d <= 5; d++) {
      await tx`INSERT INTO account_metrics_daily (workspace_id, connection_id, date, impressions) VALUES (${ws}, ${c!.id}, current_date - ${d}::int, 10)`;
      await tx`INSERT INTO pin_metrics_daily (workspace_id, connection_id, pin_id, date, impressions) VALUES (${ws}, ${c!.id}, 'p1', current_date - ${d}::int, 3)`;
    }
    await tx`INSERT INTO pin_meta (workspace_id, connection_id, pin_id, link, link_domain, has_link) VALUES (${ws}, ${c!.id}, 'p1', 'https://x.test/a', 'x.test', true)`;
    const [i] = await tx<{ id: string }[]>`INSERT INTO incident (workspace_id, connection_id, status, tier, result, detector_version) VALUES (${ws}, ${c!.id}, 'drop', 'drop_detected', '{}', 't') RETURNING id`;
    await tx`INSERT INTO alert (workspace_id, incident_id, tier, channel, title, body) VALUES (${ws}, ${i!.id}, 'drop_detected', 'in_app', 't', 'b')`;
    return c!.id;
  });
});
afterAll(async () => {
  await stopBoss();
  await own.end();
  await closeDb();
});

describe("disconnect and purge", () => {
  it("refuses to purge an active connection", async () => {
    await expect(purgeConnection(ws, conn)).rejects.toThrow(/active/);
  });

  it("disconnect destroys tokens immediately; purge removes every row; consent keeps only a hash", async () => {
    await disconnect({ workspaceId: ws, connectionId: conn, actor: "test", reason: "user" });
    const [c] = await withWorkspace(ws, (tx) => tx`SELECT status, access_token_ct, wrapped_key FROM pinterest_connection WHERE id = ${conn}`);
    expect(c).toMatchObject({ status: "disconnected", access_token_ct: null, wrapped_key: null });

    const counts = await purgeConnection(ws, conn);
    expect(counts.account_metrics_daily).toBe(5);
    expect(counts.pin_metrics_daily).toBe(5);
    expect(counts.alert).toBe(1);

    const leftovers = await assertPurged();
    expect(leftovers.find((l) => l.connectionId === conn)).toBeUndefined();
    const [cr] = await withWorkspace(ws, (tx) => tx`SELECT pinterest_user_id, pinterest_username, revoked_at FROM consent_record WHERE connection_id = ${conn}`);
    expect(cr!.pinterest_username).toBe("purged");
    expect(cr!.pinterest_user_id).toMatch(/^sha256:/);
    expect(cr!.revoked_at).not.toBeNull();
    const [log] = await withWorkspace(ws, (tx) => tx`SELECT completed_at, rows_deleted FROM deletion_log WHERE connection_id = ${conn}`);
    expect(log!.completed_at).not.toBeNull();
  });
});

describe("retention", () => {
  it("deletes raw API metrics older than the raw window and keeps recent ones", async () => {
    const a = await makeOrgUser(own);
    const w = await createWorkspace(a.userId, a.orgId, { name: "Ret", kind: "own" });
    await withWorkspace(w, async (tx) => {
      const [c] = await tx<{ id: string }[]>`INSERT INTO pinterest_connection (workspace_id, mode, pinterest_user_id, username, scopes) VALUES (${w}, 'mock', 'r', 'r', ${["pins:read"]}) RETURNING id`;
      await tx`INSERT INTO account_metrics_daily (workspace_id, connection_id, date, impressions, source) VALUES
        (${w}, ${c!.id}, current_date - 120, 1, 'api'), (${w}, ${c!.id}, current_date - 10, 2, 'api'), (${w}, ${c!.id}, current_date - 120, 3, 'csv')`;
    });
    const r = await runRetention();
    expect(r.rawCutoff).toBeTruthy();
    const rows = await withWorkspace(w, (tx) => tx<{ impressions: bigint; source: string }[]>`SELECT impressions, source FROM account_metrics_daily ORDER BY impressions`);
    expect(rows.map((x) => `${x.source}:${Number(x.impressions)}`)).toEqual(["api:2", "csv:3"]);
  });
});
