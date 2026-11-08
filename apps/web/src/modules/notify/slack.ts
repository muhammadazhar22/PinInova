import { newDataKey, openSecret, sealSecret, unwrapDataKey } from "@/lib/crypto/vault";
import type { Tx } from "@/lib/db";

/** Slack incoming-webhook URLs are bearer credentials: stored sealed like OAuth tokens. */
export async function setSlackWebhook(tx: Tx, workspaceId: string, url: string | null) {
  if (url === null) {
    await tx`UPDATE alert_settings SET slack_webhook_ct = NULL, slack_wrapped_key = NULL, slack_kek_version = NULL, updated_at = now() WHERE workspace_id = ${workspaceId}`;
    return;
  }
  const u = new URL(url);
  if (u.protocol !== "https:" || u.hostname !== "hooks.slack.com") throw new Error("Only https://hooks.slack.com/ webhook URLs are accepted");
  const k = newDataKey(workspaceId, "slack");
  await tx`
    INSERT INTO alert_settings (workspace_id, slack_webhook_ct, slack_wrapped_key, slack_kek_version)
    VALUES (${workspaceId}, ${sealSecret(k.dataKey, workspaceId, "slack", "webhook", url)}, ${k.wrappedKey}, ${k.kekVersion})
    ON CONFLICT (workspace_id) DO UPDATE SET slack_webhook_ct = EXCLUDED.slack_webhook_ct, slack_wrapped_key = EXCLUDED.slack_wrapped_key,
      slack_kek_version = EXCLUDED.slack_kek_version, updated_at = now()`;
}

export async function getSlackWebhook(tx: Tx, workspaceId: string): Promise<string | null> {
  const [s] = await tx<{ slack_webhook_ct: Buffer | null; slack_wrapped_key: Buffer | null; slack_kek_version: string | null }[]>`
    SELECT slack_webhook_ct, slack_wrapped_key, slack_kek_version FROM alert_settings WHERE workspace_id = ${workspaceId}`;
  if (!s?.slack_webhook_ct || !s.slack_wrapped_key || !s.slack_kek_version) return null;
  const dk = unwrapDataKey(workspaceId, "slack", { wrappedKey: s.slack_wrapped_key, kekVersion: s.slack_kek_version });
  return openSecret(dk, workspaceId, "slack", "webhook", s.slack_webhook_ct);
}

export async function postSlack(url: string, text: string, fetchImpl: typeof fetch = fetch) {
  const res = await fetchImpl(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }), signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`slack ${res.status}`);
}
