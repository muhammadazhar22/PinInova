import type { Tx } from "./db";

export async function audit(
  tx: Tx,
  e: { orgId?: string | null; workspaceId?: string | null; actor: string; action: string; target?: string; detail?: Record<string, unknown> },
) {
  await tx`INSERT INTO audit_event (org_id, workspace_id, actor, action, target, detail)
           VALUES (${e.orgId ?? null}, ${e.workspaceId ?? null}, ${e.actor}, ${e.action}, ${e.target ?? null}, ${tx.json((e.detail ?? {}) as never)})`;
}
