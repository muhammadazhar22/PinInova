import type postgres from "postgres";

/**
 * Database role checks run by scripts/migrate.ts (SPEC-073), so a managed Postgres (Neon) is set up safely:
 *
 * - The migration owner must bypass RLS (superuser, or BYPASSRLS as Neon gives console/API roles): the audited
 *   SECURITY DEFINER `system_*` functions read FORCE-RLS tables as the owner.
 * - `pinpulse_app` must be created by the migrations (NOSUPERUSER NOBYPASSRLS). A role created in the Neon console gets
 *   BYPASSRLS, which would silently switch off tenant isolation, so we refuse to continue if the app role can bypass RLS.
 * - On PostgreSQL 16 a non-superuser creator holds only ADMIN on the roles it creates; `CREATE SCHEMA ... AUTHORIZATION
 *   pinpulse_app` (pg-boss) needs SET, so the owner grants itself SET (not INHERIT) on the app role.
 * - The app role's password comes from DATABASE_URL, so there is one source of truth and no default password in production.
 */
export const APP_ROLE = "pinpulse_app";
export const DEFAULT_APP_PASSWORD = "pinpulse_app";

export class RoleSetupError extends Error {}

export function appPasswordFrom(databaseUrl: string | undefined): string | null {
  if (!databaseUrl) return null;
  try {
    const u = new URL(databaseUrl);
    return decodeURIComponent(u.username) === APP_ROLE && u.password ? decodeURIComponent(u.password) : null;
  } catch {
    return null;
  }
}

type Sql = postgres.Sql;

export async function prepareRoles(sql: Sql, opts: { appPassword: string | null; production: boolean }) {
  const [me] = await sql<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean }[]>`
    SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`;
  if (!me) throw new RoleSetupError("cannot read the current role");
  if (!me.rolsuper && !me.rolbypassrls) {
    throw new RoleSetupError(`migration role "${me.rolname}" must be a superuser or have BYPASSRLS (Neon's project owner role has it)`);
  }
  if (opts.production && (!opts.appPassword || opts.appPassword === DEFAULT_APP_PASSWORD)) {
    throw new RoleSetupError(`set DATABASE_URL to postgres://${APP_ROLE}:<strong password>@... in production; the default password is refused`);
  }
  const pw = opts.appPassword ?? DEFAULT_APP_PASSWORD;
  const [exists] = await sql`SELECT 1 FROM pg_roles WHERE rolname = ${APP_ROLE}`;
  if (!exists) await sql.unsafe(`CREATE ROLE ${APP_ROLE} LOGIN PASSWORD ${literal(pw)} NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`);
  if (!me.rolsuper) {
    try {
      await sql.unsafe(`GRANT ${APP_ROLE} TO "${me.rolname}" WITH INHERIT FALSE, SET TRUE`);
    } catch (e) {
      throw new RoleSetupError(`could not grant SET on ${APP_ROLE} to ${me.rolname} (was ${APP_ROLE} created by another role?): ${(e as Error).message}`);
    }
  }
}

export async function finishRoles(sql: Sql, opts: { appPassword: string | null }) {
  if (opts.appPassword) await sql.unsafe(`ALTER ROLE ${APP_ROLE} PASSWORD ${literal(opts.appPassword)}`);
  await assertAppRoleIsolated(sql);
}

export async function assertAppRoleIsolated(sql: Sql, role = APP_ROLE) {
  const [r] = await sql<{ rolsuper: boolean; rolbypassrls: boolean }[]>`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = ${role}`;
  if (!r) throw new RoleSetupError(`${role} does not exist`);
  if (r.rolsuper || r.rolbypassrls) {
    throw new RoleSetupError(`${role} can bypass row-level security (superuser or BYPASSRLS), which disables tenant isolation. ` +
      `Do not create it in the Neon console; drop it and let the migrations create it, or run ALTER ROLE ${role} NOBYPASSRLS.`);
  }
}

function literal(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}
