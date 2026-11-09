/**
 * Runs Better Auth's schema migration, then PinPulse's SQL migrations in order, as the schema owner.
 * Usage: DATABASE_OWNER_URL=... tsx scripts/migrate.ts
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { getMigrations } from "better-auth/db/migration";
import postgres from "postgres";
import { authOptions } from "../src/modules/auth/options";
import { appPasswordFrom, finishRoles, prepareRoles } from "../src/lib/db-roles";

const ownerUrl = process.env.DATABASE_OWNER_URL ?? "postgres://postgres:dev@localhost:5432/pinpulse";

async function main() {
  // Roles first (SPEC-073): owner can bypass RLS, pinpulse_app exists with NOBYPASSRLS and the owner may SET to it.
  const appPassword = appPasswordFrom(process.env.DATABASE_URL);
  const roles = postgres(ownerUrl, { max: 1, onnotice: () => {} });
  try {
    await prepareRoles(roles, { appPassword, production: process.env.NODE_ENV === "production" });
  } finally {
    await roles.end();
  }

  const opts = authOptions(ownerUrl, process.env.APP_URL ?? "http://localhost:3000", "migration-only-secret-0123456789abcdef");
  const { runMigrations, toBeCreated, toBeAdded } = await getMigrations(opts);
  if (toBeCreated.length || toBeAdded.length) {
    console.log(`better-auth: creating ${toBeCreated.map((t) => t.table).join(", ") || "-"}; altering ${toBeAdded.map((t) => t.table).join(", ") || "-"}`);
    await runMigrations();
  }
  await (opts.database as { end(): Promise<void> }).end();

  const sql = postgres(ownerUrl, { max: 1, onnotice: () => {} });
  try {
    await sql`CREATE TABLE IF NOT EXISTS schema_migration (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
    const dir = path.join(import.meta.dirname, "..", "db", "migrations");
    const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
    const applied = new Set((await sql<{ name: string }[]>`SELECT name FROM schema_migration`).map((r) => r.name));
    for (const f of files) {
      if (applied.has(f)) continue;
      const body = await readFile(path.join(dir, f), "utf8");
      await sql.begin(async (tx) => {
        await tx.unsafe(body);
        await tx`INSERT INTO schema_migration(name) VALUES (${f})`;
      });
      console.log(`applied ${f}`);
    }
    // Better Auth tables are created after grants in earlier runs; re-grant idempotently.
    await sql.unsafe(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO pinpulse_app;
                      GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO pinpulse_app;`);
    await finishRoles(sql, { appPassword });
    console.log("roles ok: pinpulse_app cannot bypass row-level security");
  } finally {
    await sql.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
