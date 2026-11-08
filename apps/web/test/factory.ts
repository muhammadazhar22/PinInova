import { randomUUID } from "node:crypto";
import postgres from "postgres";

export const owner = () => postgres(process.env.DATABASE_OWNER_URL!, { max: 2, onnotice: () => {} });

/** Create a user + org (+ membership) directly as the schema owner. */
export async function makeOrgUser(sql: postgres.Sql, opts: { role?: string; name?: string } = {}) {
  const userId = randomUUID();
  const orgId = randomUUID();
  await sql`INSERT INTO "user" (id, name, email, "emailVerified") VALUES (${userId}, ${opts.name ?? "Test"}, ${userId + "@t.test"}, true)`;
  await sql`INSERT INTO organization (id, name, slug, "createdAt") VALUES (${orgId}, ${"Org " + orgId.slice(0, 4)}, ${orgId}, now())`;
  await sql`INSERT INTO member (id, "organizationId", "userId", role, "createdAt") VALUES (${randomUUID()}, ${orgId}, ${userId}, ${opts.role ?? "owner"}, now())`;
  return { userId, orgId };
}

export async function makeUser(sql: postgres.Sql) {
  const userId = randomUUID();
  await sql`INSERT INTO "user" (id, name, email, "emailVerified") VALUES (${userId}, 'U', ${userId + "@t.test"}, true)`;
  return userId;
}
