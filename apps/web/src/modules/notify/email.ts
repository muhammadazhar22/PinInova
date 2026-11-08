import { env } from "@/env";
import { db, withWorkspace, type Tx } from "@/lib/db";

/** Queue an email. Transport "outbox" stores it for inspection (dev/tests); "resend" sends via Resend's HTTP API. */
/** Queue an e-mail. Pass connectionId when the body names a Pinterest account, so purging the connection removes it. */
export async function queueEmail(tx: Tx | null, m: { workspaceId: string | null; connectionId?: string | null; to: string; subject: string; html: string }) {
  const sql = tx ?? db();
  const [r] = await sql<{ id: string }[]>`
    INSERT INTO email_outbox (workspace_id, connection_id, to_address, subject, html, transport)
    VALUES (${m.workspaceId}, ${m.connectionId ?? null}, ${m.to}, ${m.subject}, ${m.html}, ${env().EMAIL_TRANSPORT})
    RETURNING id`;
  return r!.id;
}

/** Send immediately without storing (used when the recipient's data is being erased). */
export async function sendEmailNow(m: { to: string; subject: string; html: string }) {
  const e = env();
  if (e.EMAIL_TRANSPORT === "outbox" || !e.RESEND_API_KEY) {
    console.log(JSON.stringify({ t: new Date().toISOString(), msg: "email.sent_unstored", transport: "outbox", subject: m.subject }));
    return;
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${e.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: e.EMAIL_FROM, to: [m.to], subject: m.subject, html: m.html }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`resend ${res.status}`);
}

export async function deliverEmail(workspaceId: string, id: string) {
  const e = env();
  await withWorkspace(workspaceId, async (tx) => {
    const [m] = await tx<{ to_address: string; subject: string; html: string; sent_at: Date | null; transport: string }[]>`SELECT * FROM email_outbox WHERE id = ${id} FOR UPDATE`;
    if (!m || m.sent_at) return;
    if (m.transport === "outbox") {
      await tx`UPDATE email_outbox SET sent_at = now() WHERE id = ${id}`;
      return;
    }
    if (!e.RESEND_API_KEY) throw new Error("RESEND_API_KEY not set");
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${e.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: e.EMAIL_FROM, to: [m.to_address], subject: m.subject, html: m.html }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      await tx`UPDATE email_outbox SET error = ${`resend ${res.status}`} WHERE id = ${id}`;
      throw new Error(`resend ${res.status}`);
    }
    await tx`UPDATE email_outbox SET sent_at = now(), error = NULL WHERE id = ${id}`;
  });
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
