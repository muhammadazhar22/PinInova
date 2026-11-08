import { env } from "@/env";
import { db, withWorkspace, type Tx } from "@/lib/db";

/** Queue an email. Transport "outbox" stores it for inspection (dev/tests); "resend" sends via Resend's HTTP API. */
export async function queueEmail(tx: Tx | null, m: { workspaceId: string | null; to: string; subject: string; html: string }) {
  const sql = tx ?? db();
  const [r] = await sql<{ id: string }[]>`
    INSERT INTO email_outbox (workspace_id, to_address, subject, html, transport) VALUES (${m.workspaceId}, ${m.to}, ${m.subject}, ${m.html}, ${env().EMAIL_TRANSPORT})
    RETURNING id`;
  return r!.id;
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
