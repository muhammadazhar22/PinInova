import { db, withOrg, withWorkspace, type Tx } from "@/lib/db";
import { audit } from "@/lib/audit";

export type Role = "owner" | "admin" | "member" | "client_viewer";
export interface WorkspaceAccess {
  workspaceId: string;
  orgId: string;
  role: Role;
  canManage: boolean;
}

export class AccessDenied extends Error {
  constructor(msg = "Not allowed") {
    super(msg);
  }
}

/** Authorization for a workspace. Org members get their org role; client viewers get read-only. */
export async function resolveAccess(userId: string, workspaceId: string): Promise<WorkspaceAccess> {
  if (!/^[0-9a-f-]{36}$/i.test(workspaceId)) throw new AccessDenied("Unknown workspace");
  const sql = db();
  const [ws] = await sql<{ org: string | null }[]>`SELECT system_workspace_org(${workspaceId}::uuid) AS org`;
  const orgId = ws?.org;
  if (!orgId) throw new AccessDenied("Unknown workspace");
  const [m] = await sql<{ role: string }[]>`SELECT role FROM member WHERE "organizationId" = ${orgId} AND "userId" = ${userId}`;
  if (m) {
    const role = (["owner", "admin", "member"].includes(m.role) ? m.role : "member") as Role;
    return { workspaceId, orgId, role, canManage: true };
  }
  const [a] = await sql<{ role: string | null }[]>`SELECT system_has_workspace_access(${workspaceId}::uuid, ${userId}) AS role`;
  if (a?.role === "client_viewer") return { workspaceId, orgId, role: "client_viewer", canManage: false };
  throw new AccessDenied();
}

export async function requireManage(userId: string, workspaceId: string): Promise<WorkspaceAccess> {
  const acc = await resolveAccess(userId, workspaceId);
  if (!acc.canManage) throw new AccessDenied("Read-only access");
  return acc;
}

/** Run a tenant-scoped transaction after an authorization check. */
export async function asUser<T>(userId: string, workspaceId: string, fn: (tx: Tx, acc: WorkspaceAccess) => Promise<T>, opts: { manage?: boolean } = {}) {
  const acc = opts.manage ? await requireManage(userId, workspaceId) : await resolveAccess(userId, workspaceId);
  // Client viewers get no org context: org-scoped RLS (workspace list, org audit) must not open up for them.
  return withWorkspace(workspaceId, (tx) => fn(tx, acc), acc.role === "client_viewer" ? undefined : acc.orgId);
}

export async function listOrgsForUser(userId: string) {
  return db()<{ id: string; name: string; slug: string; role: string }[]>`
    SELECT o.id, o.name, o.slug, m.role FROM member m JOIN organization o ON o.id = m."organizationId"
    WHERE m."userId" = ${userId} ORDER BY o."createdAt"`;
}

export async function listWorkspacesForUser(userId: string) {
  const orgs = await listOrgsForUser(userId);
  const out: { id: string; name: string; kind: string; niche: string | null; org_id: string; org_name: string; role: Role }[] = [];
  for (const o of orgs) {
    const rows = await withOrg(o.id, (tx) => tx<{ id: string; name: string; kind: string; niche: string | null }[]>`
      SELECT id, name, kind, niche FROM workspace WHERE org_id = ${o.id} ORDER BY created_at`);
    for (const r of rows) out.push({ ...r, org_id: o.id, org_name: o.name, role: o.role as Role });
  }
  const client = await db()<{ workspace_id: string; workspace_name: string; org_id: string; org_name: string }[]>`
    SELECT * FROM system_client_workspaces(${userId})`;
  for (const c of client) out.push({ id: c.workspace_id, name: c.workspace_name, kind: "client", niche: null, org_id: c.org_id, org_name: c.org_name, role: "client_viewer" });
  return out;
}

export async function createWorkspace(userId: string, orgId: string, input: { name: string; kind: "own" | "client"; niche?: string | null }) {
  const [m] = await db()<{ role: string }[]>`SELECT role FROM member WHERE "organizationId" = ${orgId} AND "userId" = ${userId}`;
  if (!m) throw new AccessDenied();
  return withOrg(orgId, async (tx) => {
    const [w] = await tx<{ id: string }[]>`
      INSERT INTO workspace (org_id, name, kind, niche) VALUES (${orgId}, ${input.name.trim()}, ${input.kind}, ${input.niche ?? null}) RETURNING id`;
    await audit(tx, { orgId, actor: userId, action: "workspace.create", target: w!.id, detail: { name: input.name, kind: input.kind } });
    return w!.id;
  });
}

/** Grant a client read-only access to one workspace (agency mode). */
export async function grantClientViewer(actorId: string, workspaceId: string, clientUserId: string) {
  return asUser(actorId, workspaceId, async (tx, acc) => {
    await tx`INSERT INTO workspace_access (workspace_id, user_id, role) VALUES (${workspaceId}, ${clientUserId}, 'client_viewer')
             ON CONFLICT DO NOTHING`;
    await audit(tx, { orgId: acc.orgId, workspaceId, actor: actorId, action: "workspace.grant_client_viewer", target: clientUserId });
  }, { manage: true });
}

/** Create an organisation with the user as owner (same tables Better Auth's organization plugin uses). */
export async function createOrganization(userId: string, name: string) {
  const { randomUUID } = await import("node:crypto");
  const id = randomUUID();
  const slug = `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "org"}-${id.slice(0, 6)}`;
  await db().begin(async (tx) => {
    await tx`INSERT INTO organization (id, name, slug, "createdAt") VALUES (${id}, ${name}, ${slug}, now())`;
    await tx`INSERT INTO member (id, "organizationId", "userId", role, "createdAt") VALUES (${randomUUID()}, ${id}, ${userId}, 'owner', now())`;
    await audit(tx as unknown as Tx, { orgId: id, actor: userId, action: "org.create", detail: { name } });
  });
  return id;
}

/**
 * Invite a client to view a workspace (read-only). Access is granted only when someone opens the e-mailed,
 * single-use link while signed in — possession of the link proves control of the address, so pre-registering
 * a client's e-mail address gains nothing.
 */
export async function inviteClientViewer(actorId: string, workspaceId: string, email: string) {
  const { newToken, hashToken } = await import("@/lib/tokens");
  const { queueEmail } = await import("@/modules/notify/email");
  const { escapeHtml } = await import("@/modules/notify/email");
  const token = newToken();
  const url = `${process.env.APP_URL ?? "http://localhost:3000"}/invite/${token}`;
  const id = await asUser(actorId, workspaceId, async (tx, acc) => {
    const [w] = await tx<{ name: string }[]>`SELECT name FROM workspace WHERE id = ${workspaceId}`;
    const [inv] = await tx<{ id: string }[]>`
      INSERT INTO viewer_invite (workspace_id, email, token_hash, invited_by, expires_at)
      VALUES (${workspaceId}, ${email}, ${hashToken(token)}, ${actorId}, now() + interval '14 days') RETURNING id`;
    const emailId = await queueEmail(tx, {
      workspaceId, to: email, subject: `You're invited to view "${w?.name ?? "a workspace"}" on PinInova`,
      html: `<p>You've been invited to view the Pinterest health workspace <b>${escapeHtml(w?.name ?? "")}</b> (read-only).</p><p><a href="${url}">Accept the invitation</a> — the link works once and expires in 14 days.</p>`,
    });
    await audit(tx, { orgId: acc.orgId, workspaceId, actor: actorId, action: "workspace.invite_client_viewer", target: inv!.id });
    return emailId;
  }, { manage: true });
  return { emailId: id, url };
}

export async function acceptViewerInvite(userId: string, token: string): Promise<string | null> {
  const { hashToken } = await import("@/lib/tokens");
  const [r] = await db()<{ ws: string | null }[]>`SELECT system_accept_viewer_invite(${hashToken(token)}, ${userId}) AS ws`;
  return r?.ws ?? null;
}
