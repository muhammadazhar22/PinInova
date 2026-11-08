import { env } from "@/env";
import { withWorkspace, type Tx } from "@/lib/db";
import { entitlements } from "@/modules/billing/plans";
import { CAUSE_LABELS, type Cause, type DiagnoseResponse } from "@/modules/health/analytics-client";
import { escapeHtml, queueEmail } from "@/modules/notify/email";
import { benjaminiHochberg, causeThreshold, qValues } from "./stats";

const Q_NOTIFY = 0.05;

/**
 * Alert evaluation for ONE workspace. False-discovery control is applied across the workspace's own
 * accounts only: decisions for one tenant never depend on another tenant's data (policy: PA-05/PA-06).
 * Tiers:
 *  - watch: early CUSUM warning (in-app only)
 *  - drop_detected: confirmed drop, both changepoint methods agree, BH q ≤ 0.05 (in-app + email)
 *  - action_needed: drop_detected and the top cause is one the user can act on (A/B/C) with
 *    probability ≥ the cost-sensitive threshold from their sensitivity setting (+ Slack)
 */
export async function evaluateAlerts(workspaceId: string, orgId: string, now = new Date()) {
  const ent = await entitlements(orgId);
  return withWorkspace(workspaceId, async (tx) => {
    const [settings] = await tx<{ sensitivity: number; emails: string[]; slack_webhook_ct: Buffer | null }[]>`
      SELECT sensitivity, emails, slack_webhook_ct FROM alert_settings WHERE workspace_id = ${workspaceId}`;
    const sensitivity = settings?.sensitivity ?? 0.5;
    const incidents = await tx<{ id: string; status: string; tier: string; p_value: number | null; methods_agree: boolean | null; top_cause: Cause | null; result: DiagnoseResponse; connection_id: string; username: string }[]>`
      SELECT i.id, i.status, i.tier, i.p_value, i.methods_agree, i.top_cause, i.result, i.connection_id, c.username
      FROM incident i JOIN pinterest_connection c ON c.id = i.connection_id
      WHERE i.state = 'open' AND i.detected_at > ${new Date(now.getTime() - 30 * 86400_000)} AND c.status = 'active'`;
    const drops = incidents.filter((i) => i.status === "drop" && i.p_value !== null);
    const reject = benjaminiHochberg(drops.map((d) => d.p_value!), Q_NOTIFY);
    const qs = qValues(drops.map((d) => d.p_value!));
    const created: string[] = [];

    for (const inc of incidents) {
      let tier = inc.status === "warning" ? "watch" : "watch";
      const di = drops.indexOf(inc);
      if (di >= 0) {
        await tx`UPDATE incident SET q_value = ${qs[di]!} WHERE id = ${inc.id}`;
        if (reject[di] && inc.methods_agree) {
          tier = "drop_detected";
          const top = inc.result.classes[0];
          if (top && ["A_enforcement", "B_quality", "C_behavioural"].includes(top.cause) && top.probability >= causeThreshold(sensitivity)) tier = "action_needed";
        }
      }
      if (rank(tier) > rank(inc.tier)) await tx`UPDATE incident SET tier = ${tier} WHERE id = ${inc.id}`;
      const effectiveTier = rank(tier) >= rank(inc.tier) ? tier : inc.tier;
      const channels: ("in_app" | "email" | "slack")[] = ["in_app"];
      if (effectiveTier !== "watch" && settings?.emails?.length) channels.push("email");
      if (effectiveTier === "action_needed" && settings?.slack_webhook_ct && ent.slack) channels.push("slack");
      for (const ch of channels) {
        const msg = renderAlert(inc.username, effectiveTier, inc.result);
        const [a] = await tx<{ id: string }[]>`
          INSERT INTO alert (workspace_id, incident_id, tier, channel, title, body)
          SELECT ${workspaceId}, ${inc.id}, ${effectiveTier}, ${ch}, ${msg.title}, ${msg.text}
          WHERE NOT EXISTS (SELECT 1 FROM alert WHERE incident_id = ${inc.id} AND tier = ${effectiveTier} AND channel = ${ch})
          RETURNING id`;
        if (!a) continue;
        created.push(a.id);
        if (ch === "email") {
          for (const to of settings!.emails) await queueEmail(tx, { workspaceId, connectionId: inc.connection_id, to, subject: msg.title, html: msg.html });
        }
        if (ch === "in_app") await tx`UPDATE alert SET delivered_at = now() WHERE id = ${a.id}`;
      }
    }
    return { evaluated: incidents.length, created };
  });
}

function rank(t: string) {
  return ["watch", "drop_detected", "action_needed", "platform_broadcast"].indexOf(t);
}

/** Alert copy. Never promises recovery, never says "shadowban". */
export function renderAlert(username: string, tier: string, r: DiagnoseResponse) {
  const top = r.classes[0];
  const label = top ? CAUSE_LABELS[top.cause] : null;
  const pct = r.drop ? Math.round(r.drop.effect * 100) : null;
  const title =
    tier === "watch"
      ? `Early warning: impressions falling on @${username}`
      : `${tier === "action_needed" ? "Action needed" : "Drop detected"}: @${username} impressions down ${pct ?? "?"}% since ${r.onset_date ?? r.warning_date}`;
  const lines = [
    title,
    label ? `Most likely cause: ${label.title} (${Math.round((top!.probability ?? 0) * 100)}% of our model's weight, ${r.confidence} confidence). ${label.short}` : "Not enough data yet to name a likely cause.",
    ...r.evidence.slice(0, 3).map((e) => `• ${e.text}`),
    "What not to do: don't delete Pins in bulk, don't file several appeals (Pinterest caps appeals), and don't rewrite everything at once.",
    `Open the incident: ${env().APP_URL}/app`,
  ];
  const html = `<div style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.5">${lines.map((l) => `<p>${escapeHtml(l)}</p>`).join("")}
    <p style="color:#666;font-size:12px">PinPulse is not affiliated with Pinterest. Causes are likely explanations from your account's data, not confirmations from Pinterest.</p></div>`;
  return { title, text: lines.join("\n"), html };
}

export async function recordAlertFeedback(tx: Tx, alertId: string, useful: boolean) {
  await tx`UPDATE alert SET useful = ${useful}, feedback_at = now() WHERE id = ${alertId}`;
}

/** Undelivered Slack alerts and unsent emails for a workspace, for the worker to deliver. */
export async function pendingDeliveries(workspaceId: string) {
  return withWorkspace(workspaceId, async (tx) => ({
    slack: (await tx<{ id: string }[]>`SELECT id FROM alert WHERE channel = 'slack' AND delivered_at IS NULL AND delivery_error IS NULL`).map((r) => r.id),
    email: (await tx<{ id: string }[]>`SELECT id FROM email_outbox WHERE sent_at IS NULL AND error IS NULL`).map((r) => r.id),
  }));
}

export async function deliverSlackAlert(workspaceId: string, alertId: string, fetchImpl?: typeof fetch) {
  const { getSlackWebhook, postSlack } = await import("@/modules/notify/slack");
  await withWorkspace(workspaceId, async (tx) => {
    const [a] = await tx<{ body: string; delivered_at: Date | null }[]>`SELECT body, delivered_at FROM alert WHERE id = ${alertId} FOR UPDATE`;
    if (!a || a.delivered_at) return;
    const url = await getSlackWebhook(tx, workspaceId);
    if (!url) {
      await tx`UPDATE alert SET delivery_error = 'no webhook configured' WHERE id = ${alertId}`;
      return;
    }
    try {
      await postSlack(url, a.body, fetchImpl);
      await tx`UPDATE alert SET delivered_at = now() WHERE id = ${alertId}`;
    } catch (e) {
      await tx`UPDATE alert SET delivery_error = ${(e as Error).message} WHERE id = ${alertId}`;
    }
  });
}
