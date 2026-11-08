/**
 * End-to-end pipeline against the mock Pinterest server and the real analytics service.
 * Requires: services/pinterest-mock and services/analytics running (scripts/test-e2e.sh starts them).
 * Each scenario account must produce its documented signature.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, withWorkspace } from "@/lib/db";
import { createWorkspace } from "@/modules/workspaces/access";
import { stopBoss } from "@/modules/jobs/boss";
import { completeConnect, createConsentRequest, disconnect, lookupConsentRequest, revokeByToken, startConnect } from "@/modules/pinterest/connections";
import { syncAccount } from "@/modules/sync/sync";
import { analyzeAccount } from "@/modules/health/analyze";
import { runIntegrityChecks } from "@/modules/integrity/run";
import { evaluateAlerts } from "@/modules/alerts/evaluate";
import { buildEvidencePack, buildMonthlyReport } from "@/modules/reports/build";
import { assertPurged, purgeConnection } from "@/modules/privacy/purge";
import { closePdf, renderReportPdf } from "@/modules/reports/pdf";
import { leakCheckMock } from "@/modules/attribution/ga4";
import { todayUtc } from "@/lib/dates";
import { makeOrgUser, owner } from "./factory";

const MOCK = process.env.MOCK_BASE ?? "http://127.0.0.1:4010";
const own = owner();
let orgId = "";
let userId = "";

async function connectAs(ws: string, mockUser: string, consentRequestId?: string) {
  const url = await startConnect({ workspaceId: ws, userId: consentRequestId ? null : userId, consentRequestId, redirectTo: "/done" });
  const u = new URL(url);
  expect(u.origin).toBe(MOCK);
  u.searchParams.set("mock_user", mockUser);
  const res = await fetch(u, { redirect: "manual" });
  expect(res.status).toBeGreaterThanOrEqual(300);
  const back = new URL(res.headers.get("location")!);
  return completeConnect({ state: back.searchParams.get("state")!, code: back.searchParams.get("code") });
}

async function fullRun(mockUser: string) {
  const ws = await createWorkspace(userId, orgId, { name: mockUser, kind: "client" });
  const c = await connectAs(ws, mockUser);
  const sync = await syncAccount(ws, c.connectionId);
  const analysis = await analyzeAccount(ws, c.connectionId);
  const integrity = await runIntegrityChecks(ws, c.connectionId);
  const alerts = await evaluateAlerts(ws, orgId);
  const issues = await withWorkspace(ws, (tx) => tx<{ kind: string; state: string }[]>`SELECT kind, state FROM issue WHERE connection_id = ${c.connectionId}`);
  return { ws, conn: c.connectionId, sync, analysis, integrity, alerts, issues };
}

beforeAll(async () => {
  const h = await fetch(`${MOCK}/__mock/state`).catch(() => null);
  if (!h?.ok) throw new Error(`mock Pinterest server not reachable at ${MOCK}; run scripts/test-e2e.sh`);
  await fetch(`${MOCK}/__mock/reset`, { method: "POST" });
  ({ orgId, userId } = await makeOrgUser(own));
  await own`UPDATE subscription SET plan = 'agency' WHERE org_id = ${orgId}`.catch(() => null);
  await own`INSERT INTO subscription (org_id, plan, status) VALUES (${orgId}, 'agency', 'active') ON CONFLICT (org_id) DO UPDATE SET plan = 'agency'`;
});
afterAll(async () => {
  await closePdf();
  await stopBoss();
  await own.end();
  await closeDb();
});

describe("scenario signatures", () => {
  it("healthy account: no drop, a health score, tokens sealed", async () => {
    const r = await fullRun("mock_healthy");
    expect(r.sync.trackedPins).toBeGreaterThan(10);
    expect(r.sync.accountRows).toBeGreaterThanOrEqual(80);
    expect(r.analysis.result?.status).not.toBe("drop");
    expect(r.analysis.score).toBeGreaterThan(50);
    const [row] = await withWorkspace(r.ws, (tx) => tx<{ access_token_ct: Buffer }[]>`SELECT access_token_ct FROM pinterest_connection WHERE id = ${r.conn}`);
    expect(row!.access_token_ct.toString("utf8")).not.toMatch(/^[a-z0-9_.-]{20,}$/i);
    const titles = await own`SELECT column_name FROM information_schema.columns WHERE table_name IN ('pin_meta','pin_metrics_daily','account_metrics_daily') AND column_name IN ('title','description','image','image_url')`;
    expect(titles).toHaveLength(0);
  });

  it("platform cliff: drop detected, distribution cut, platform-side cause ranked first", async () => {
    const r = await fullRun("mock_platform_cliff");
    const res = r.analysis.result!;
    expect(res.status).toBe("drop");
    expect(res.drop!.effect).toBeGreaterThan(0.6);
    expect(res.rate.verdict).not.toBe("changed");
    expect(res.classes[0]!.cause).toBe("D_platform");
    const [inc] = await withWorkspace(r.ws, (tx) => tx<{ tier: string }[]>`SELECT tier FROM incident WHERE connection_id = ${r.conn}`);
    expect(["drop_detected", "action_needed"]).toContain(inc!.tier);
  });

  it("domain block: drop confined to one domain is surfaced, robots issue found", async () => {
    const r = await fullRun("mock_domain_block");
    // Account-level loss is ~40%, under the 50% drop threshold; the domain scan must still catch deal-hub.
    const kinds = r.issues.map((i) => i.kind);
    expect(kinds).toContain("domain:robots_blocks_pinterestbot");
    expect(kinds).toContain("domain:traffic_drop");
    const [d] = await withWorkspace(r.ws, (tx) => tx<{ detail: { domains: { domain: string; effect: number }[] } }[]>`SELECT detail FROM issue WHERE connection_id = ${r.conn} AND kind = 'domain:traffic_drop'`);
    expect(d!.detail.domains[0]!.domain).toMatch(/deal-hub/);
    expect(d!.detail.domains[0]!.effect).toBeGreaterThan(0.8);
    expect(d!.detail.domains.map((x) => x.domain).join()).not.toMatch(/cozy-kitchen|garden-notes/);
  });

  it("new Pins at zero: behavioural cause and duplicate images detected", async () => {
    const r = await fullRun("mock_new_pins_zero");
    expect(r.integrity.duplicates).toBeGreaterThan(0);
    expect(r.issues.map((i) => i.kind)).toContain("content:duplicate_images");
  });
});

describe("more scenario signatures", () => {
  it("quality drop: engagement rate fell with impressions, broken links flagged", async () => {
    const r = await fullRun("mock_quality_drop");
    const res = r.analysis.result!;
    expect(res.status).toBe("drop");
    expect(res.rate.verdict).toBe("changed");
    expect(res.classes[0]!.cause).toBe("B_quality");
    expect(r.issues.map((i) => i.kind)).toContain("link:broken");
  });

  it("viral fade: smooth decay of one viral Pin is not reported as a cliff and raises no alert", async () => {
    const r = await fullRun("mock_viral_fade");
    const res = r.analysis.result!;
    if (res.status === "drop") expect(res.classes[0]!.cause).toBe("E_decay");
    else expect(r.alerts.created).toHaveLength(0);
  });

  it("agency client 1 and 2: redirect chain, crawl-delay and slow pages", async () => {
    const a = await fullRun("mock_agency_client_1");
    expect(a.issues.map((i) => i.kind)).toContain("link:redirect_chain");
    const b = await fullRun("mock_agency_client_2");
    const kinds = b.issues.map((i) => i.kind);
    expect(kinds).toContain("domain:crawl_delay");
    expect(kinds).toContain("link:slow");
  });

  it("platform cliff raises an alert in the outbox; a healthy account does not", async () => {
    const outbox = await own<{ n: number }[]>`SELECT count(*)::int AS n FROM alert WHERE workspace_id IN (SELECT id FROM workspace WHERE name = 'mock_platform_cliff')`;
    const healthy = await own<{ n: number }[]>`SELECT count(*)::int AS n FROM alert WHERE workspace_id IN (SELECT id FROM workspace WHERE name = 'mock_healthy')`;
    expect(outbox[0]!.n).toBeGreaterThan(0);
    expect(healthy[0]!.n).toBe(0);
  });
});

describe("agency consent flow, reports, revocation and purge", () => {
  it("client connects via consent link; agency reports; client revokes; data is purged", async () => {
    const ws = await createWorkspace(userId, orgId, { name: "Agency client", kind: "client" });
    const link = await createConsentRequest({ workspaceId: ws, orgId, actor: userId, clientEmail: "client@example.com" });
    const token = link.url.split("/").pop()!;
    const req = await lookupConsentRequest(token);
    expect(req?.workspace_id).toBe(ws);
    const c = await connectAs(ws, "mock_agency_client_1", req!.consent_request_id);
    expect(c.viaClientLink).toBe(true);
    expect(c.revokeToken).toBeTruthy();
    // single use
    await expect(connectAs(ws, "mock_agency_client_1", req!.consent_request_id)).rejects.toThrow(/already been used|expired/);

    await syncAccount(ws, c.connectionId);
    await analyzeAccount(ws, c.connectionId);
    await leakCheckMock(ws, c.connectionId, userId, todayUtc());
    const reportId = await buildMonthlyReport(ws, orgId, c.connectionId, userId);
    const pdf = await renderReportPdf(ws, reportId);
    expect(pdf.subarray(0, 4).toString()).toBe("%PDF");
    const [rep] = await withWorkspace(ws, (tx) => tx<{ html: string }[]>`SELECT html FROM report WHERE id = ${reportId}`);
    expect(rep!.html).toContain("SIMULATED DATA");
    expect(rep!.html).not.toMatch(/recover(y|ed) (is )?guarantee|shadowban/i);

    expect(await revokeByToken(c.revokeToken!)).toBe(true);
    await purgeConnection(ws, c.connectionId);
    const left = await assertPurged();
    expect(left.find((l) => l.connectionId === c.connectionId)).toBeUndefined();
  });

  it("evidence pack for a detected drop contains ticket text and no promises", async () => {
    const ws = await createWorkspace(userId, orgId, { name: "Evidence", kind: "client" });
    const c = await connectAs(ws, "mock_platform_cliff");
    await syncAccount(ws, c.connectionId);
    const a = await analyzeAccount(ws, c.connectionId);
    await runIntegrityChecks(ws, c.connectionId);
    const pack = await buildEvidencePack(ws, orgId, a.incidentId!, userId);
    expect(pack.ticket).toMatch(/dropped starting/);
    expect(pack.ticket).toMatch(/limited distribution/);
    await disconnect({ workspaceId: ws, connectionId: c.connectionId, actor: "test", reason: "user" });
    await purgeConnection(ws, c.connectionId);
  });

  it("a revoked Pinterest grant flags the connection for re-authorization", async () => {
    const ws = await createWorkspace(userId, orgId, { name: "Revoked", kind: "own" });
    const c = await connectAs(ws, "mock_agency_client_2");
    await fetch(`${MOCK}/__mock/revoke`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "mock_agency_client_2" }) });
    await expect(syncAccount(ws, c.connectionId)).rejects.toThrow();
    const [row] = await withWorkspace(ws, (tx) => tx<{ status: string }[]>`SELECT status FROM pinterest_connection WHERE id = ${c.connectionId}`);
    expect(row!.status).toBe("needs_reauth");
  });
});
