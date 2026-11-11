import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { resetEnvCache } from "@/env";
import { closeDb, withWorkspace } from "@/lib/db";
import { stopBoss } from "@/modules/jobs/boss";
import { createWorkspace } from "@/modules/workspaces/access";
import { evaluateAlerts } from "./evaluate";
import { makeOrgUser, owner } from "../../../test/factory";

const own = owner();
let ws = "";
let orgId = "";

beforeAll(async () => {
  const a = await makeOrgUser(own);
  orgId = a.orgId;
  ws = await createWorkspace(a.userId, a.orgId, { name: "New-Pin alerts", kind: "own" });
  await withWorkspace(ws, async (tx) => {
    const [c] = await tx<{ id: string }[]>`INSERT INTO pinterest_connection (workspace_id, mode, pinterest_user_id, username, scopes)
      VALUES (${ws}, 'mock', 'pu_np', 'batch_poster', ${["pins:read"]}) RETURNING id`;
    await tx`INSERT INTO issue (workspace_id, connection_id, kind, source, severity, title, detail, affected_count)
      VALUES (${ws}, ${c!.id}, 'distribution:new_pins', 'unknown', 'warning',
              '30 new Pins from the last 3 weeks get about 1.2 views a day; older Pins get about 23', '{}', 30)`;
    await tx`INSERT INTO alert_settings (workspace_id, emails) VALUES (${ws}, ${["va@example.com"]})`;
  });
});
afterEach(() => {
  delete process.env.NEW_PINS_ALERTS;
  resetEnvCache();
});
afterAll(async () => {
  await stopBoss();
  await closeDb();
  await own.end();
});

const alertsFor = () => withWorkspace(ws, (tx) => tx<{ channel: string; tier: string; title: string }[]>`
  SELECT channel, tier, title FROM alert WHERE issue_id IS NOT NULL ORDER BY channel`);
const emails = () => withWorkspace(ws, (tx) => tx<{ subject: string }[]>`SELECT subject FROM email_outbox`);

describe("new-Pin warning alerts (SPEC-079 follow-up)", () => {
  it("sends nothing while NEW_PINS_ALERTS is off (default)", async () => {
    await evaluateAlerts(ws, orgId);
    expect(await alertsFor()).toHaveLength(0);
  });

  it("alerts in-app and by e-mail once per issue when switched on", async () => {
    process.env.NEW_PINS_ALERTS = "true";
    resetEnvCache();
    await evaluateAlerts(ws, orgId);
    await evaluateAlerts(ws, orgId); // nightly re-run: no duplicates
    const a = await alertsFor();
    expect(a.map((x) => x.channel)).toEqual(["email", "in_app"]);
    expect(a[0]!.tier).toBe("new_pins");
    expect(a[0]!.title).toMatch(/@batch_poster/);
    expect(a[0]!.title).not.toMatch(/guarantee|shadowban/i);
    expect((await emails()).filter((e) => /new Pins/i.test(e.subject))).toHaveLength(1);
  });
});
