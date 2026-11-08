import { audit } from "@/lib/audit";
import { db, withOrg } from "@/lib/db";
import { disconnect } from "@/modules/pinterest/connections";
import { purgeConnection } from "./purge";
import { sendEmailNow } from "@/modules/notify/email";

/**
 * GDPR erasure for a user. For organisations where the user is the only owner, every Pinterest
 * connection is disconnected and purged and the organisation (with its workspaces) is deleted.
 * Audit rows keep the event but lose the actor identity.
 */
export async function eraseUser(userId: string) {
  const sql = db();
  const [u] = await sql<{ email: string }[]>`SELECT email FROM "user" WHERE id = ${userId}`;
  if (!u) return { deletedOrgs: 0 };
  const orgs = await sql<{ org: string; owners: number }[]>`
    SELECT m."organizationId" AS org, (SELECT count(*)::int FROM member x WHERE x."organizationId" = m."organizationId" AND x.role = 'owner') AS owners
    FROM member m WHERE m."userId" = ${userId} AND m.role = 'owner'`;
  let deletedOrgs = 0;
  for (const o of orgs.filter((o) => o.owners === 1)) {
    const wss = await withOrg(o.org, (tx) => tx<{ id: string }[]>`SELECT id FROM workspace WHERE org_id = ${o.org}`);
    for (const w of wss) {
      const conns = await db().begin(async (tx) => {
        await tx`SELECT set_config('app.workspace_id', ${w.id}, true)`;
        return tx<{ id: string; status: string }[]>`SELECT id, status FROM pinterest_connection WHERE status <> 'purged'`;
      });
      for (const c of conns) {
        if (c.status !== "disconnected") await disconnect({ workspaceId: w.id, connectionId: c.id, actor: "system:erasure", reason: "account_deleted" });
        await purgeConnection(w.id, c.id);
      }
    }
    await withOrg(o.org, async (tx) => {
      await audit(tx, { orgId: o.org, actor: "system:erasure", action: "org.deleted" });
    });
    await sql`DELETE FROM organization WHERE id = ${o.org}`;
    deletedOrgs++;
  }
  // Cross-tenant by nature: a SECURITY DEFINER function anonymises the actor everywhere and drops queued mail to the address.
  await sql`SELECT system_anonymise_actor(${userId})`;
  await sql`DELETE FROM "user" WHERE id = ${userId}`;
  // Confirmation is sent directly and never stored, so the erased address does not persist in the outbox.
  await sendEmailNow({ to: u.email, subject: "Your PinPulse account was deleted", html: "<p>Your PinPulse account and the Pinterest data it held have been deleted.</p>" })
    .catch((err) => console.error(JSON.stringify({ msg: "erasure.confirmation_failed", error: (err as Error).message })));
  return { deletedOrgs };
}
