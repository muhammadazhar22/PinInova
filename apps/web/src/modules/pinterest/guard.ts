import type { Tx } from "@/lib/db";

/** The connection is disconnected, purged or missing (or not in this workspace): the work is skipped, not failed. */
export class InactiveConnectionError extends Error {
  constructor(readonly status: string) {
    super(`connection not active (${status})`);
  }
}

/**
 * Call first inside every transaction that writes rows for a connection.
 * - Proves the connection belongs to the current workspace (RLS hides other tenants' rows → "missing").
 * - Takes a FOR SHARE lock, so disconnect/purge (which UPDATE the row) wait for this transaction and
 *   this transaction cannot write after a purge has started (no data resurrected after deletion).
 */
export async function lockConnection(tx: Tx, connectionId: string, allowed: readonly string[] = ["active", "needs_reauth"]) {
  const [c] = await tx<{ status: string }[]>`SELECT status FROM pinterest_connection WHERE id = ${connectionId} FOR SHARE`;
  if (!c || !allowed.includes(c.status)) throw new InactiveConnectionError(c?.status ?? "missing");
  return c.status;
}
