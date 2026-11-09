/**
 * Test database location. Defaults to local Postgres with the `postgres` superuser as owner.
 * Neon-like run (CI job web-neon-owner): TEST_PG_PORT=5433 TEST_DB_OWNER=neon_owner:dev, where neon_owner is
 * NOSUPERUSER CREATEROLE CREATEDB BYPASSRLS and pinpulse_app does not exist yet.
 */
export function testDb() {
  const port = process.env.TEST_PG_PORT ?? "5432";
  const [role, pw] = (process.env.TEST_DB_OWNER ?? "").split(":");
  const owner = role ? `${role}:${pw ?? ""}` : "postgres:dev";
  return {
    adminUrl: `postgres://postgres:dev@localhost:${port}/postgres`,
    ownerUrl: `postgres://${owner}@localhost:${port}/pinpulse_test`,
    appUrl: `postgres://pinpulse_app:pinpulse_app@localhost:${port}/pinpulse_test`,
    ownerRole: role || null,
  };
}
