import { execFileSync } from "node:child_process";
import postgres from "postgres";
import { testDb } from "./db-config";

export default async function setup() {
  const t = testDb();
  const admin = postgres(t.adminUrl, { max: 1, onnotice: () => {} });
  await admin.unsafe("DROP DATABASE IF EXISTS pinpulse_test WITH (FORCE)");
  // With TEST_DB_OWNER the database is owned by a non-superuser, like Neon's neondb_owner (SPEC-073).
  await admin.unsafe(t.ownerRole ? `CREATE DATABASE pinpulse_test OWNER "${t.ownerRole}"` : "CREATE DATABASE pinpulse_test");
  await admin.end();
  execFileSync("npx", ["tsx", "scripts/migrate.ts"], {
    stdio: "inherit",
    env: { ...process.env, DATABASE_OWNER_URL: t.ownerUrl, DATABASE_URL: t.appUrl },
  });
}
