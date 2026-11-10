"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { audit } from "@/lib/audit";
import { db } from "@/lib/db";
import { recordAlertFeedback } from "@/modules/alerts/evaluate";
import { leakCheckFromCsv, leakCheckMock } from "@/modules/attribution/ga4";
import { createTokens, importOrdersCsv } from "@/modules/attribution/shopify";
import { requireUser } from "@/modules/auth/session";
import { ensureSubscription } from "@/modules/billing/plans";
import { simulateCheckout } from "@/modules/billing/paddle";
import { importAnalyticsCsv } from "@/modules/imports/csv-history";
import { enqueue, QUEUES } from "@/modules/jobs/boss";
import { createConsentRequest, disconnect } from "@/modules/pinterest/connections";
import { lockConnection } from "@/modules/pinterest/guard";
import { setSlackWebhook } from "@/modules/notify/slack";
import { preflightCsv } from "@/modules/preflight/preflight";
import { eraseUser } from "@/modules/privacy/erasure";
import { buildEvidencePack, buildMonthlyReport, createShareLink, revokeShareLink } from "@/modules/reports/build";
import { acceptViewerInvite, asUser, createOrganization, createWorkspace, inviteClientViewer } from "@/modules/workspaces/access";
import { todayUtc } from "@/lib/dates";

const uuid = z.string().uuid();
const MAX_CSV = 5 * 1024 * 1024;

async function readCsv(f: FormData, field = "file"): Promise<string> {
  const file = f.get(field);
  if (!(file instanceof File) || file.size === 0) throw new Error("Choose a CSV file");
  if (file.size > MAX_CSV) throw new Error("CSV is larger than 5 MB");
  return file.text();
}

export type ActionState = { ok?: boolean; error?: string; message?: string; data?: unknown } | null;
function fail(e: unknown): ActionState {
  return { error: e instanceof Error ? e.message : "Something went wrong" };
}

// Onboarding ---------------------------------------------------------------------------------
export async function createOrgAndWorkspace(_: ActionState, f: FormData): Promise<ActionState> {
  const user = await requireUser();
  const orgName = z.string().min(2).max(80).parse(String(f.get("org") || "My PinInova"));
  const wsName = z.string().min(1).max(120).parse(String(f.get("workspace") || "My Pinterest"));
  const kind = f.get("kind") === "client" ? "client" : "own";
  const niche = String(f.get("niche") || "") || null;
  const orgId = await createOrganization(user.id, orgName);
  await ensureSubscription(orgId);
  const ws = await createWorkspace(user.id, orgId, { name: wsName, kind, niche });
  redirect(`/app/w/${ws}`);
}

export async function addWorkspace(f: FormData) {
  const user = await requireUser();
  const orgId = z.string().min(1).parse(f.get("org"));
  const ws = await createWorkspace(user.id, orgId, { name: String(f.get("name") || "Client"), kind: f.get("kind") === "own" ? "own" : "client", niche: String(f.get("niche") || "") || null });
  redirect(`/app/w/${ws}`);
}

// Connections ------------------------------------------------------------------------------
export async function createConsentLink(_: ActionState, f: FormData): Promise<ActionState> {
  try {
    const user = await requireUser();
    const ws = uuid.parse(f.get("ws"));
    const email = String(f.get("email") || "").trim() || null;
    if (email) z.string().email().parse(email);
    const acc = await asUser(user.id, ws, async (_tx, a) => a, { manage: true });
    const { url } = await createConsentRequest({ workspaceId: ws, orgId: acc.orgId, actor: user.id, clientEmail: email });
    revalidatePath(`/app/w/${ws}`);
    return { ok: true, message: url };
  } catch (e) {
    return fail(e);
  }
}

export async function syncNow(f: FormData) {
  const user = await requireUser();
  const ws = uuid.parse(f.get("ws"));
  const conn = uuid.parse(f.get("conn"));
  await asUser(user.id, ws, async (tx) => {
    const [c] = await tx`SELECT 1 FROM pinterest_connection WHERE id = ${conn} AND status = 'active'`;
    if (!c) throw new Error("Connection is not active");
    await audit(tx, { workspaceId: ws, actor: user.id, action: "connection.sync_requested", target: conn });
  }, { manage: true });
  await enqueue(QUEUES.syncAccount, { connectionId: conn, workspaceId: ws, reason: "manual" }, { singletonKey: conn });
  revalidatePath(`/app/w/${ws}/a/${conn}`);
}

export async function runChecksNow(f: FormData) {
  const user = await requireUser();
  const ws = uuid.parse(f.get("ws"));
  const conn = uuid.parse(f.get("conn"));
  await asUser(user.id, ws, async () => null, { manage: true });
  await enqueue(QUEUES.integrityChecks, { connectionId: conn, workspaceId: ws }, { singletonKey: `integrity:${conn}` });
  revalidatePath(`/app/w/${ws}/a/${conn}`);
}

export async function disconnectAction(f: FormData) {
  const user = await requireUser();
  const ws = uuid.parse(f.get("ws"));
  const conn = uuid.parse(f.get("conn"));
  if (f.get("confirm") !== "DELETE") throw new Error("Type DELETE to confirm");
  await asUser(user.id, ws, async () => null, { manage: true });
  await disconnect({ workspaceId: ws, connectionId: conn, actor: user.id, reason: "user" });
  redirect(`/app/w/${ws}?disconnected=1`);
}

export async function recordObserved(f: FormData) {
  const user = await requireUser();
  const ws = uuid.parse(f.get("ws"));
  const conn = uuid.parse(f.get("conn"));
  const kind = z.enum(["visit_site_demoted", "domain_block_error", "ai_label", "search_invisible"]).parse(f.get("kind"));
  const note = String(f.get("note") || "").slice(0, 500) || null;
  await asUser(user.id, ws, async (tx) => {
    await lockConnection(tx, conn);
    await tx`INSERT INTO observed_signal (workspace_id, connection_id, kind, note, created_by) VALUES (${ws}, ${conn}, ${kind}, ${note}, ${user.id})`;
  }, { manage: true });
  revalidatePath(`/app/w/${ws}/a/${conn}`);
}

export async function issueAction(f: FormData) {
  const user = await requireUser();
  const ws = uuid.parse(f.get("ws"));
  const id = uuid.parse(f.get("issue"));
  const op = z.enum(["validate", "suppress", "reopen"]).parse(f.get("op"));
  await asUser(user.id, ws, async (tx) => {
    const state = op === "validate" ? "validating" : op === "suppress" ? "suppressed" : "open";
    await tx`UPDATE issue SET state = ${state}, validate_started_at = CASE WHEN ${state} = 'validating' THEN now() ELSE validate_started_at END WHERE id = ${id}`;
    await audit(tx, { workspaceId: ws, actor: user.id, action: `issue.${op}`, target: id });
  }, { manage: true });
  revalidatePath(`/app/w/${ws}`, "layout");
}

export async function incidentFeedback(f: FormData) {
  const user = await requireUser();
  const ws = uuid.parse(f.get("ws"));
  const id = uuid.parse(f.get("incident"));
  const cause = String(f.get("cause") || "") || null;
  const state = z.enum(["open", "acknowledged", "resolved"]).parse(f.get("state") || "acknowledged");
  await asUser(user.id, ws, async (tx) => {
    await tx`UPDATE incident SET state = ${state}, user_cause = coalesce(${cause}, user_cause), user_feedback_at = now() WHERE id = ${id}`;
    await audit(tx, { workspaceId: ws, actor: user.id, action: "incident.feedback", target: id, detail: { state, cause } });
  }, { manage: true });
  revalidatePath(`/app/w/${ws}`, "layout");
}

// Reports ------------------------------------------------------------------------------------
export async function buildReportAction(f: FormData) {
  const user = await requireUser();
  const ws = uuid.parse(f.get("ws"));
  const conn = uuid.parse(f.get("conn"));
  const acc = await asUser(user.id, ws, async (_t, a) => a, { manage: true });
  const id = await buildMonthlyReport(ws, acc.orgId, conn, user.id);
  await enqueue(QUEUES.buildReport, { workspaceId: ws, reportId: id });
  redirect(`/app/w/${ws}/reports?created=${id}`);
}

export async function evidencePackAction(f: FormData) {
  const user = await requireUser();
  const ws = uuid.parse(f.get("ws"));
  const incident = uuid.parse(f.get("incident"));
  const acc = await asUser(user.id, ws, async (_t, a) => a, { manage: true });
  const r = await buildEvidencePack(ws, acc.orgId, incident, user.id);
  await enqueue(QUEUES.buildReport, { workspaceId: ws, reportId: r.id });
  redirect(`/app/w/${ws}/reports?created=${r.id}`);
}

export async function shareReport(_: ActionState, f: FormData): Promise<ActionState> {
  try {
    const user = await requireUser();
    const ws = uuid.parse(f.get("ws"));
    const id = uuid.parse(f.get("report"));
    await asUser(user.id, ws, async () => null, { manage: true });
    if (f.get("op") === "revoke") {
      await revokeShareLink(ws, id, user.id);
      revalidatePath(`/app/w/${ws}/reports`);
      return { ok: true, message: "Link revoked" };
    }
    const url = await createShareLink(ws, id, user.id);
    revalidatePath(`/app/w/${ws}/reports`);
    return { ok: true, message: url };
  } catch (e) {
    return fail(e);
  }
}

// Alerts -------------------------------------------------------------------------------------
export async function saveAlertSettings(_: ActionState, f: FormData): Promise<ActionState> {
  try {
    const user = await requireUser();
    const ws = uuid.parse(f.get("ws"));
    const sensitivity = z.coerce.number().min(0.05).max(0.95).parse(f.get("sensitivity"));
    const emails = String(f.get("emails") || "").split(/[\s,;]+/).filter(Boolean);
    for (const e of emails) z.string().email().parse(e);
    const slack = String(f.get("slack") || "").trim();
    await asUser(user.id, ws, async (tx) => {
      await tx`INSERT INTO alert_settings (workspace_id, sensitivity, emails) VALUES (${ws}, ${sensitivity}, ${emails})
               ON CONFLICT (workspace_id) DO UPDATE SET sensitivity = EXCLUDED.sensitivity, emails = EXCLUDED.emails, updated_at = now()`;
      if (f.get("slack_clear") === "1") await setSlackWebhook(tx, ws, null);
      else if (slack) await setSlackWebhook(tx, ws, slack);
      await audit(tx, { workspaceId: ws, actor: user.id, action: "alerts.settings_saved", detail: { sensitivity, emails: emails.length, slack: Boolean(slack) } });
    }, { manage: true });
    revalidatePath(`/app/w/${ws}/alerts`);
    return { ok: true, message: "Saved" };
  } catch (e) {
    return fail(e);
  }
}

export async function alertFeedback(f: FormData) {
  const user = await requireUser();
  const ws = uuid.parse(f.get("ws"));
  const id = uuid.parse(f.get("alert"));
  await asUser(user.id, ws, (tx) => recordAlertFeedback(tx, id, f.get("useful") === "1"), { manage: true });
  revalidatePath(`/app/w/${ws}/alerts`);
}

// Imports, pre-flight, attribution -----------------------------------------------------------
export async function importCsvAction(_: ActionState, f: FormData): Promise<ActionState> {
  try {
    const user = await requireUser();
    const ws = uuid.parse(f.get("ws"));
    const conn = uuid.parse(f.get("conn"));
    await asUser(user.id, ws, async () => null, { manage: true });
    const r = await importAnalyticsCsv(ws, conn, user.id, await readCsv(f));
    await enqueue(QUEUES.analyzeAccount, { connectionId: conn, workspaceId: ws });
    revalidatePath(`/app/w/${ws}/a/${conn}`);
    return { ok: true, message: `Imported ${r.rows} days (${r.range?.join(" to ") ?? ""}). Columns used: ${Object.entries(r.columns).map(([k, v]) => `${k}←"${v}"`).join(", ")}${r.warnings.length ? `. Warnings: ${r.warnings.join("; ")}` : ""}` };
  } catch (e) {
    return fail(e);
  }
}

export async function preflightAction(_: ActionState, f: FormData): Promise<ActionState> {
  try {
    const user = await requireUser();
    const ws = uuid.parse(f.get("ws"));
    const conn = f.get("conn") ? uuid.parse(f.get("conn")) : null;
    await asUser(user.id, ws, async () => null);
    return { ok: true, data: await preflightCsv(ws, conn, await readCsv(f)) };
  } catch (e) {
    return fail(e);
  }
}

export async function leakAction(_: ActionState, f: FormData): Promise<ActionState> {
  try {
    const user = await requireUser();
    const ws = uuid.parse(f.get("ws"));
    const conn = uuid.parse(f.get("conn"));
    await asUser(user.id, ws, async () => null, { manage: true });
    const r = f.get("mode") === "mock" ? await leakCheckMock(ws, conn, user.id, todayUtc()) : await leakCheckFromCsv(ws, conn, user.id, await readCsv(f));
    revalidatePath(`/app/w/${ws}/attribution`);
    return { ok: true, data: r };
  } catch (e) {
    return fail(e);
  }
}

export async function tokensAction(_: ActionState, f: FormData): Promise<ActionState> {
  try {
    const user = await requireUser();
    const ws = uuid.parse(f.get("ws"));
    const conn = uuid.parse(f.get("conn"));
    await asUser(user.id, ws, async () => null, { manage: true });
    const lines = String(f.get("links") || "").split(/\n/).map((l) => l.trim()).filter(Boolean);
    const items = lines.map((l) => {
      const [label, link] = l.includes("|") ? l.split("|").map((x) => x.trim()) : [l, l];
      new URL(link!);
      return { label: label!, link: link! };
    });
    if (!items.length) throw new Error("Add at least one URL");
    const out = await createTokens(ws, conn, user.id, items);
    revalidatePath(`/app/w/${ws}/attribution`);
    return { ok: true, data: out };
  } catch (e) {
    return fail(e);
  }
}

export async function ordersAction(_: ActionState, f: FormData): Promise<ActionState> {
  try {
    const user = await requireUser();
    const ws = uuid.parse(f.get("ws"));
    const conn = uuid.parse(f.get("conn"));
    await asUser(user.id, ws, async () => null, { manage: true });
    const r = await importOrdersCsv(ws, conn, user.id, await readCsv(f));
    revalidatePath(`/app/w/${ws}/attribution`);
    return { ok: true, message: `Imported ${r.rows} orders; ${r.matched} carried a PinInova token.` };
  } catch (e) {
    return fail(e);
  }
}

// Agency, billing, account -------------------------------------------------------------------
export async function grantViewerAction(_: ActionState, f: FormData): Promise<ActionState> {
  try {
    const user = await requireUser();
    const ws = uuid.parse(f.get("ws"));
    const email = z.string().email().parse(String(f.get("email") || "").trim().toLowerCase());
    const r = await inviteClientViewer(user.id, ws, email);
    await enqueue(QUEUES.sendEmail, { workspaceId: ws, emailId: r.emailId });
    revalidatePath(`/app/w/${ws}/settings`);
    return { ok: true, message: `Invitation sent to ${email}. They get read-only access when they open the link while signed in.` };
  } catch (e) {
    return fail(e);
  }
}

export async function acceptInviteAction(f: FormData) {
  const user = await requireUser();
  const token = z.string().min(20).max(100).parse(f.get("token"));
  const ws = await acceptViewerInvite(user.id, token);
  if (!ws) redirect(`/invite/${encodeURIComponent(token)}?e=invalid`);
  redirect(`/app/w/${ws}`);
}

export async function simulateCheckoutAction(f: FormData) {
  const user = await requireUser();
  const orgId = z.string().min(1).parse(f.get("org"));
  const [m] = await db()<{ role: string }[]>`SELECT role FROM member WHERE "organizationId" = ${orgId} AND "userId" = ${user.id}`;
  if (!m || !["owner", "admin"].includes(m.role)) throw new Error("Only owners can change the plan");
  await simulateCheckout(orgId, z.enum(["solo", "pro", "agency"]).parse(f.get("plan")), Number(f.get("extra") || 0));
  revalidatePath("/app/billing");
}

export async function deleteAccountAction(f: FormData) {
  const user = await requireUser();
  if (f.get("confirm") !== user.email) throw new Error("Type your email to confirm");
  await eraseUser(user.id);
  redirect("/?deleted=1");
}
